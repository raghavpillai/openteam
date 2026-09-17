/** Decode the Swift client's wire payloads with the production server schemas. */
import {createRequire} from 'node:module';
const {Schema} = createRequire(new URL('../../../packages/contracts/package.json',import.meta.url))('effect');
import {CreateBotInput,DuplicateBotInput,UpdateBotInput,CreateGroupInput,SetChannelMembersInput,UpdateChannelProfileInput,SetChannelHiddenInput,SendMessageInput,ReactToChannelMessageInput,InstallPluginInput,RenamePluginAccountInput,SetPluginToolPolicyInput,ScreenActionInput,ScreenTakeoverInput,ComputerHandoffMutationInput,PluginConfigurationInput,PluginSkillInput,PluginUrlInput,PluginPackageInput,PluginDraftInput,PluginModeInput,PluginTestInput} from '../../../packages/contracts/src/index';
const rules:[string,RegExp,any][]=[
 ['POST',/^\/api\/v0\/bots$/,CreateBotInput],['PATCH',/^\/api\/v0\/bots\/[^/]+$/,UpdateBotInput],['POST',/\/duplicate$/,DuplicateBotInput],
 ['POST',/^\/api\/v0\/channels$/,CreateGroupInput],['PUT',/\/members$/,SetChannelMembersInput],['PATCH',/\/profile$/,UpdateChannelProfileInput],['PATCH',/\/hidden$/,SetChannelHiddenInput],
 ['POST',/\/messages$/,SendMessageInput],['POST',/\/reaction$/,ReactToChannelMessageInput],['POST',/\/plugins\/install$/,InstallPluginInput],['PATCH',/\/plugin-connections\/[^/]+\/account$/,RenamePluginAccountInput],['POST',/\/policy$/,SetPluginToolPolicyInput],
 ['POST',/\/screen\/actions$/,ScreenActionInput],['POST',/\/screen\/takeover$/,ScreenTakeoverInput],['POST',/\/computer-handoff$/,ComputerHandoffMutationInput],
 ['PUT',/\/configuration$/,PluginConfigurationInput],['POST',/^\/api\/v0\/plugin-skills$/,PluginSkillInput],['PUT',/^\/api\/v0\/plugin-skills\/[^/]+$/,PluginSkillInput],
 ['POST',/^\/api\/v0\/plugin-sources$/,PluginUrlInput],['PUT',/^\/api\/v0\/plugin-sources\/[^/]+$/,PluginUrlInput],['PUT',/^\/api\/v0\/plugin-drafts\/[^/]+$/,PluginDraftInput],['POST',/\/mode$/,PluginModeInput],['POST',/\/plugin-connections\/[^/]+\/test$/,PluginTestInput]
];
export function validateFixtureRequest(path:string,method:string,input:unknown):string|null {
 const rule=rules.find(([verb,pattern])=>verb===method&&pattern.test(path));if(!rule)return null;
 try{Schema.decodeUnknownSync(rule[2])(input);return null}catch(error){return `Production contract rejected this request: ${error instanceof Error?error.message:String(error)}`}
}
