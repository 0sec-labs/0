import {describe,expect,it} from "vitest";
import {accountEnvPatch,normalizeAccountStore,type AccountStore} from "./credential-store.js";
const store=(client?:unknown):AccountStore=>normalizeAccountStore({version:2,providers:{google:{activeAccountId:"fixture",accounts:{fixture:{kind:"oauth",tokens:{refreshToken:"fixture-refresh"},...(client===undefined?{}:{oauthClient:client})}}}}});
describe("stored Google client binding",()=>{
 it("roundtrips metadata and overrides unrelated client flags with the selected record",()=>{
  const value=store({clientId:" own ",clientSecret:" own-secret "});
  expect(value.providers.google?.accounts.fixture).toMatchObject({oauthClient:{clientId:"own",clientSecret:"own-secret"}});
  expect(accountEnvPatch(value,{ZERO_GEMINI_OAUTH_CLIENT_ID:"wrong",ZERO_GEMINI_OAUTH_CLIENT_SECRET:"wrong"})).toMatchObject({ZERO_GEMINI_OAUTH_CLIENT_ID:"own",ZERO_GEMINI_OAUTH_CLIENT_SECRET:"own-secret",ZERO_GEMINI_OAUTH_REFRESH_TOKEN:"fixture-refresh"});
 });
 it("never falls back to an unrelated secret or client for public and legacy records",()=>{
  expect(accountEnvPatch(store({clientId:"own"}),{})).toMatchObject({ZERO_GEMINI_OAUTH_CLIENT_ID:"own",ZERO_GEMINI_OAUTH_CLIENT_SECRET:""});
  expect(accountEnvPatch(store(),{ZERO_GEMINI_OAUTH_CLIENT_ID:"wrong"})).toMatchObject({ZERO_GEMINI_OAUTH_CLIENT_ID:"",ZERO_GEMINI_OAUTH_CLIENT_SECRET:""});
 });
 it("rejects malformed metadata instead of treating the token as legacy",()=>{
  for(const client of [{clientSecret:"secret"},{clientId:"bad\nclient"},null])expect(store(client).providers.google).toBeUndefined();
 });
 it("preserves explicit shell token precedence",()=>expect(accountEnvPatch(store({clientId:"own"}),{ZERO_GEMINI_OAUTH_REFRESH_TOKEN:"explicit"})).toEqual({}));
});
