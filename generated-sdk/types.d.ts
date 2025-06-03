/**
 * AUTO‐GENERATED shared types for Vinyl SDK
 * Do not edit by hand.
 */

export type QueryParams = Record<string, any>;
export type RequestBody = any;
export type ResponseData = any;

export interface SdkClient {
  /**
   * Simple HTTP client with baseURL pointing to your Vinyl node.
   * e.g. const client = createSdkClient("http://localhost:3001")
   */
  get<T = ResponseData>(path: string, params?: QueryParams): Promise<T>;
  post<T = ResponseData>(path: string, body?: RequestBody, params?: QueryParams): Promise<T>;
  put<T = ResponseData>(path: string, body?: RequestBody, params?: QueryParams): Promise<T>;
  delete<T = ResponseData>(path: string, params?: QueryParams): Promise<T>;
}
