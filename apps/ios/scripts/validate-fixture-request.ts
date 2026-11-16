/** Decode the Swift client's wire payloads with the production server schemas. */
import {createRequire} from 'node:module';
const {Schema} = createRequire(new URL('../../../packages/contracts/package.json',import.meta.url))('effect');
import {CreateBotInput,UpdateBotInput,CreateGroupInput,SetChannelMembersInput,UpdateChannelProfileInput,SetChannelHiddenInput,SendMessageInput,ReactToChannelMessageInput} from '../../../packages/contracts/src/index';
const rules:[string,RegExp,any][]=[
 ['POST',/^\/api\/v0\/bots$/,CreateBotInput],['PATCH',/^\/api\/v0\/bots\/[^/]+$/,UpdateBotInput],
 ['POST',/^\/api\/v0\/channels$/,CreateGroupInput],['PUT',/\/members$/,SetChannelMembersInput],['PATCH',/\/profile$/,UpdateChannelProfileInput],['PATCH',/\/hidden$/,SetChannelHiddenInput],
 ['POST',/\/messages$/,SendMessageInput],['POST',/\/reaction$/,ReactToChannelMessageInput],
];
export function validateFixtureRequest(path:string,method:string,input:unknown):string|null {
 const rule=rules.find(([verb,pattern])=>verb===method&&pattern.test(path));if(!rule)return null;
 try{Schema.decodeUnknownSync(rule[2])(input);return null}catch(error){return `Production contract rejected this request: ${error instanceof Error?error.message:String(error)}`}
}
