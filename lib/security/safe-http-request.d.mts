export interface SafeHttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}

export function isPublicAddress(address: string): boolean;
export function parseSafeHttpUrl(input: string): URL;
export function executeSafeHttpRequest(options: {
  url: string;
  method?: string;
  headers?: Record<string, string | number>;
  body?: string | null;
  timeoutMs?: number;
  maxResponseBytes?: number;
}): Promise<SafeHttpResponse>;
