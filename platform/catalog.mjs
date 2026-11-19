import {registry} from './connectors/builtins.mjs';
export const catalog=registry.list();
export const oauthProviders = {
  feishu:{authorize:'https://accounts.feishu.cn/open-apis/authen/v1/authorize',token:'https://open.feishu.cn/open-apis/authen/v2/oauth/token',scope:'auth:user.id:read minutes:minutes.search:read minutes:minutes.transcript:export offline_access',setup:'https://open.feishu.cn/app'},
  github:{authorize:'https://github.com/login/oauth/authorize', token:'https://github.com/login/oauth/access_token', scope:'repo project workflow read:org offline_access', setup:'https://github.com/settings/applications/new'},
  linear:{authorize:'https://linear.app/oauth/authorize', token:'https://api.linear.app/oauth/token', scope:'read,issues:create,comments:create', setup:'https://linear.app/developers/oauth-2-0-authentication'},
};
