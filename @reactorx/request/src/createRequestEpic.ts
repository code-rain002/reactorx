import axios, { AxiosInterceptorManager, AxiosRequestConfig, AxiosResponse } from "axios";
import { forEach, set } from "lodash";
import { IEpic } from "@reactorx/core";
import { from as observableFrom, merge as observableMerge, of as observableOf } from "rxjs";
import {
  catchError as rxCatchError,
  filter as rxFilter,
  ignoreElements,
  map as rxMap,
  mergeMap as rxMergeMap,
  tap as rxTap,
} from "rxjs/operators";
import { RequestActor } from "./RequestActor";

import { paramsSerializer, transformRequest } from "./utils";

export type TRequestInterceptor = (
  request: AxiosInterceptorManager<AxiosRequestConfig>,
  response: AxiosInterceptorManager<AxiosResponse>,
) => void;

export const createRequestEpic = (options: AxiosRequestConfig, ...interceptors: TRequestInterceptor[]): IEpic => {
  const client = axios.create({
    ...options,
    paramsSerializer,
    transformRequest,
  });

  client.interceptors.request.use(setDefaultContentType);

  forEach(interceptors, (interceptor) => {
    interceptor(client.interceptors.request, client.interceptors.response);
  });

  const cancelTokenSources: { [k: string]: ReturnType<typeof axios.CancelToken.source> } = {};

  const clearTokenSource = (uid: string) => {
    delete cancelTokenSources[uid];
  };

  const cancelRequestIfExists = (uid: string) => {
    cancelTokenSources[uid] && cancelTokenSources[uid].cancel();
    clearTokenSource(uid);
  };

  const registerCancelToken = (uid: string) => {
    cancelRequestIfExists(uid);

    const source = axios.CancelToken.source();
    cancelTokenSources[uid] = source;
    return source.token;
  };

  return (actor$) => {
    return observableMerge(
      actor$.pipe(
        rxFilter(RequestActor.isPreRequestActor),
        rxMergeMap((actor) => {
          const axiosRequestConfig = actor.requestConfig();
          axiosRequestConfig.cancelToken = registerCancelToken(actor.uid());

          return observableMerge(
            observableOf(actor.started.with(axiosRequestConfig)),
            observableFrom(client.request(axiosRequestConfig)).pipe(
              rxMap((response) => actor.done.with(response)),
              rxCatchError((err) => observableOf(actor.failed.with(err))),
              rxTap(() => {
                clearTokenSource(actor.uid());
              }),
            ),
          );
        }),
      ),
      actor$.pipe(
        rxFilter(RequestActor.isCancelRequestActor),
        rxMap((actor) => {
          cancelRequestIfExists(actor.opts.parentActor.uid());
        }),
        ignoreElements(),
      ),
    );
  };
};

function setDefaultContentType(config: AxiosRequestConfig): AxiosRequestConfig {
  if (!config.headers || !config.headers["Content-Type"]) {
    set(config, ["headers", "Content-Type"], "application/json");
  }
  return config;
}
