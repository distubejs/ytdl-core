interface RefreshApiResponse {
    error_code?: string;
    access_token: string;
    refresh_token: string;
    expires_in: number;
}

import { BASE_URL } from '@/meta/youtube';
import { YTDL_OAuth2ClientData, YTDL_OAuth2Credentials } from '@/types/options';
import { Logger } from '@/utils/Log';

/* Reference: LuanRT/YouTube.js */
const REGEX = { tvScript: new RegExp('<script\\s+id="base-js"\\s+src="([^"]+)"[^>]*><\\/script>'), clientIdentity: new RegExp('clientId:"(?<client_id>[^"]+)",[^"]*?:"(?<client_secret>[^"]+)"') };

export class OAuth2 {
    isEnabled: boolean = false;
    accessToken: string = '';
    refreshToken: string = '';
    expiryDate: string = '';

    clientId?: string;
    clientSecret?: string;

    constructor(credentials?: YTDL_OAuth2Credentials) {
        if (!credentials) {
            return;
        }

        this.isEnabled = true;
        this.accessToken = credentials.accessToken;
        this.refreshToken = credentials.refreshToken;
        this.expiryDate = credentials.expiryDate;
        this.clientId = credentials.clientData?.clientId;
        this.clientSecret = credentials.clientData?.clientSecret;
    }

    private async getClientData(): Promise<YTDL_OAuth2ClientData> {
        const YT_TV_RESPONSE = await fetch(BASE_URL + '/tv', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version',
                Referer: 'https://www.youtube.com/tv',
            },
        });

        if (!YT_TV_RESPONSE.ok) {
            this.isEnabled = false;
            throw new Error('Failed to get client data: ' + YT_TV_RESPONSE.status);
        }

        const YT_TV_HTML = await YT_TV_RESPONSE.text(),
            SCRIPT_PATH = REGEX.tvScript.exec(YT_TV_HTML)?.[1];

        if (SCRIPT_PATH !== null) {
            Logger.debug('Found YouTube TV script: ' + SCRIPT_PATH);

            const SCRIPT_RESPONSE = await fetch(BASE_URL + SCRIPT_PATH);
            if (!SCRIPT_RESPONSE.ok) {
                this.isEnabled = false;
                throw new Error('TV script request failed with status code: ' + SCRIPT_RESPONSE.status);
            }

            const SCRIPT_STRING = await SCRIPT_RESPONSE.text(),
                CLIENT_ID = REGEX.clientIdentity.exec(SCRIPT_STRING)?.groups?.client_id,
                CLIENT_SECRET = REGEX.clientIdentity.exec(SCRIPT_STRING)?.groups?.client_secret;

            if (!CLIENT_ID || !CLIENT_SECRET) {
                this.isEnabled = false;
                throw new Error("Could not obtain client ID. Please create an issue in the repository for possible specification changes on YouTube's side.");
            }

            Logger.debug('Found client ID: ' + CLIENT_ID);
            Logger.debug('Found client secret: ' + CLIENT_SECRET);
            return { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET };
        }

        this.isEnabled = false;
        throw new Error("Could not obtain script URL. Please create an issue in the repository for possible specification changes on YouTube's side.");
    }

    shouldRefreshToken(): boolean {
        if (!this.isEnabled) {
            return false;
        }

        return Date.now() >= new Date(this.expiryDate).getTime();
    }

    async refreshAccessToken(): Promise<void> {
        if (!this.isEnabled) {
            return;
        }

        console.log(this)

        if (!this.clientId || !this.clientSecret) {
            const { clientId, clientSecret } = await this.getClientData();

            this.clientId = clientId;
            this.clientSecret = clientSecret;
        }

        if (!this.refreshToken) {
            throw new Error('Refresh token is missing, make sure it is specified.');
        }

        const PAYLOAD = {
                client_id: this.clientId,
                client_secret: this.clientSecret,
                refresh_token: this.refreshToken,
                grant_type: 'refresh_token',
            },
            REFRESH_API_RESPONSE = await fetch(BASE_URL + '/o/oauth2/token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(PAYLOAD),
            });

        if (!REFRESH_API_RESPONSE.ok) {
            throw new Error(`Failed to refresh access token: ${REFRESH_API_RESPONSE.status}`);
        }

        const REFRESH_API_DATA = (await REFRESH_API_RESPONSE.json()) as RefreshApiResponse;

        if (REFRESH_API_DATA.error_code) {
            throw new Error('Authorization server returned an error: ' + JSON.stringify(REFRESH_API_DATA));
        }

        this.accessToken = REFRESH_API_DATA.access_token;
        this.refreshToken = REFRESH_API_DATA.refresh_token;
        this.expiryDate = new Date(Date.now() + REFRESH_API_DATA.expires_in * 1000).toISOString();
    }

    getAccessToken(): string {
        return this.accessToken;
    }
}