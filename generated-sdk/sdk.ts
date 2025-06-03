/**
 * AUTO‐GENERATED VINYL SDK
 * Do not edit by hand.
 */

import fetch from "node-fetch";
import { SdkClient, QueryParams, RequestBody, ResponseData } from "./types";

/**
 * Create a simple SdkClient using fetch
 */
export function createSdkClient(baseURL: string): SdkClient {
  return {
    async get<T = ResponseData>(path: string, params?: QueryParams): Promise<T> {
      const url = new URL(path, baseURL);
      if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, String(v)));
      const res = await fetch(url.toString(), { method: "GET" });
      return res.json();
    },
    async post<T = ResponseData>(path: string, body?: RequestBody, params?: QueryParams): Promise<T> {
      const url = new URL(path, baseURL);
      if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, String(v)));
      const res = await fetch(url.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined
      });
      return res.json();
    },
    async put<T = ResponseData>(path: string, body?: RequestBody, params?: QueryParams): Promise<T> {
      const url = new URL(path, baseURL);
      if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, String(v)));
      const res = await fetch(url.toString(), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined
      });
      return res.json();
    },
    async delete<T = ResponseData>(path: string, params?: QueryParams): Promise<T> {
      const url = new URL(path, baseURL);
      if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, String(v)));
      const res = await fetch(url.toString(), { method: "DELETE" });
      return res.json();
    }
  };
}

/**
 * POST /api/music/search
 */
export async function post_api_music_search(client: SdkClient, body?: RequestBody): Promise<ResponseData> {
  return client.post(`/api/music/search`, body);
}

/**
 * GET /api/music/recommendations/:cid
 */
export async function get_api_music_recommendations_Bycid(cid: string, client: SdkClient, queryParams?: QueryParams): Promise<ResponseData> {
  return client.get(`/api/music/recommendations/${cid}`, queryParams);
}

/**
 * GET /api/music/stats
 */
export async function get_api_music_stats(client: SdkClient, queryParams?: QueryParams): Promise<ResponseData> {
  return client.get(`/api/music/stats`, queryParams);
}

/**
 * GET /api/music/metadata/:cid
 */
export async function get_api_music_metadata_Bycid(cid: string, client: SdkClient, queryParams?: QueryParams): Promise<ResponseData> {
  return client.get(`/api/music/metadata/${cid}`, queryParams);
}

/**
 * GET /api/music/all
 */
export async function get_api_music_all(client: SdkClient, queryParams?: QueryParams): Promise<ResponseData> {
  return client.get(`/api/music/all`, queryParams);
}

/**
 * GET /api/analytics/snapshot
 */
export async function get_api_analytics_snapshot(client: SdkClient, queryParams?: QueryParams): Promise<ResponseData> {
  return client.get(`/api/analytics/snapshot`, queryParams);
}

/**
 * GET /api/analytics/top-file-types
 */
export async function get_api_analytics_topfiletypes(client: SdkClient, queryParams?: QueryParams): Promise<ResponseData> {
  return client.get(`/api/analytics/top-file-types`, queryParams);
}

/**
 * GET /api/replication/status
 */
export async function get_api_replication_status(client: SdkClient, queryParams?: QueryParams): Promise<ResponseData> {
  return client.get(`/api/replication/status`, queryParams);
}

/**
 * POST /api/replication/on
 */
export async function post_api_replication_on(client: SdkClient, body?: RequestBody): Promise<ResponseData> {
  return client.post(`/api/replication/on`, body);
}

/**
 * POST /api/replication/off
 */
export async function post_api_replication_off(client: SdkClient, body?: RequestBody): Promise<ResponseData> {
  return client.post(`/api/replication/off`, body);
}

/**
 * POST /api/rs/upload
 */
export async function post_api_rs_upload(client: SdkClient, body?: RequestBody): Promise<ResponseData> {
  return client.post(`/api/rs/upload`, body);
}

/**
 * GET /api/rs/recover/:id
 */
export async function get_api_rs_recover_Byid(id: string, client: SdkClient, queryParams?: QueryParams): Promise<ResponseData> {
  return client.get(`/api/rs/recover/${id}`, queryParams);
}
