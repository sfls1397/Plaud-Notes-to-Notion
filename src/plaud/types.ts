export interface PlaudTokenSet {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_at?: number;
}

export interface OAuthEndpoints {
  clientId: string;
  redirectUri: string;
  authorizationUrl: string;
  tokenUrl: string;
  refreshUrl: string;
  apiBase: string;
}

export interface AuthorizationRequest {
  url: string;
  codeVerifier: string;
  state: string;
}
