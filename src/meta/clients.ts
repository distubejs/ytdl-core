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

const INNERTUBE_CLIENTS: Record<YTDL_ClientTypes, YTDL_ClientData> = {
    web: {
        INNERTUBE_CONTEXT: {
            client: {
                clientName: 'WEB',
                clientVersion: '2.20240726.00.00',
            },
        },
        INNERTUBE_CONTEXT_CLIENT_NAME: 1,
    },
    web_safari: {
        INNERTUBE_CONTEXT: {
            client: {
                clientName: 'WEB',
                clientVersion: '2.20240726.00.00',
                userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.5 Safari/605.1.15,gzip(gfe)',
            },
        },
        INNERTUBE_CONTEXT_CLIENT_NAME: 1,
    },
    web_creator: {
        INNERTUBE_CONTEXT: {
            client: {
                clientName: 'WEB_CREATOR',
                clientVersion: '1.20240723.03.00',
            },
        },
        INNERTUBE_CONTEXT_CLIENT_NAME: 62,
    },
    android: {
        INNERTUBE_CONTEXT: {
            client: {
                clientName: 'ANDROID',
                clientVersion: '19.29.37',
                androidSdkVersion: 30,
                userAgent: 'com.google.android.youtube/19.29.37 (Linux; U; Android 11) gzip',
                osName: 'Android',
                osVersion: '11',
            },
        },
        INNERTUBE_CONTEXT_CLIENT_NAME: 3,
        REQUIRE_JS_PLAYER: false,
    },
    android_creator: {
        INNERTUBE_CONTEXT: {
            client: {
                clientName: 'ANDROID_CREATOR',
                clientVersion: '24.30.100',
                androidSdkVersion: 30,
                userAgent: 'com.google.android.apps.youtube.creator/24.30.100 (Linux; U; Android 11) gzip',
                osName: 'Android',
                osVersion: '11',
            },
        },
        INNERTUBE_CONTEXT_CLIENT_NAME: 14,
        REQUIRE_JS_PLAYER: false,
    },
    ios: {
        INNERTUBE_CONTEXT: {
            client: {
                clientName: 'IOS',
                clientVersion: '19.29.1',
                deviceMake: 'Apple',
                deviceModel: 'iPhone16,2',
                userAgent: 'com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)',
                osName: 'iPhone',
                osVersion: '17.5.1.21F90',
            },
        },
        INNERTUBE_CONTEXT_CLIENT_NAME: 5,
        REQUIRE_JS_PLAYER: false,
    },
    ios_creator: {
        INNERTUBE_CONTEXT: {
            client: {
                clientName: 'IOS_CREATOR',
                clientVersion: '24.30.100',
                deviceMake: 'Apple',
                deviceModel: 'iPhone16,2',
                userAgent: 'com.google.ios.ytcreator/24.30.100 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)',
                osName: 'iPhone',
                osVersion: '17.5.1.21F90',
            },
        },
        INNERTUBE_CONTEXT_CLIENT_NAME: 15,
        REQUIRE_JS_PLAYER: false,
    },
    mweb: {
        INNERTUBE_CONTEXT: {
            client: {
                clientName: 'MWEB',
                clientVersion: '2.20240726.01.00',
            },
        },
        INNERTUBE_CONTEXT_CLIENT_NAME: 2,
    },
    tv: {
        INNERTUBE_CONTEXT: {
            client: {
                clientName: 'TVHTML5',
                clientVersion: '7.20240724.13.00',
            },
        },
        INNERTUBE_CONTEXT_CLIENT_NAME: 7,
    },
    tv_embedded: {
        INNERTUBE_CONTEXT: {
            client: {
                clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
                clientVersion: '2.0',
                clientScreen: 'EMBED',
            },
        },
        INNERTUBE_CONTEXT_CLIENT_NAME: 85,
    },
    mediaconnect: {
        INNERTUBE_CONTEXT: {
            client: {
                clientName: 'MEDIA_CONNECT_FRONTEND',
                clientVersion: '0.1',
            },
        },
        INNERTUBE_CONTEXT_CLIENT_NAME: 95,
        REQUIRE_JS_PLAYER: false,
    },
};

export { INNERTUBE_CLIENTS, YTDL_ClientTypes };
