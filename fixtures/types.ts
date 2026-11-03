export type Api = { request: (key: string, payload?: unknown) => Promise<unknown> };
export type AppProps = { api: Api };
