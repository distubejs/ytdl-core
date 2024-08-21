type YTDL_ClientTypes = 'web' | 'web_safari' | 'web_creator' | 'android' | 'android_creator' | 'ios' | 'ios_creator' | 'mweb' | 'tv' | 'tv_embedded' | 'mediaconnect';
type YTDL_ClientData = {
    INNERTUBE_CONTEXT: {
        client: {
            clientName: string;
            clientVersion: string;
            clientScreen?: string;
            visitorData?: string;
            userAgent?: string;
            osName?: string;
            osVersion?: string;
            deviceMake?: string;
            deviceModel?: string;
            originalUrl?: string;
            androidSdkVersion?: number;
        };
    };
    INNERTUBE_CONTEXT_CLIENT_NAME: number;
    REQUIRE_JS_PLAYER?: boolean;
};
declare const INNERTUBE_CLIENTS: Record<YTDL_ClientTypes, YTDL_ClientData>;
export { INNERTUBE_CLIENTS, YTDL_ClientTypes };
