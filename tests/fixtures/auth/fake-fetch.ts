export interface FakeCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

export function fakeFetch(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): typeof fetch & { readonly calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return handler(url, init);
  };
  return Object.assign(fn as typeof fetch, { calls });
}
