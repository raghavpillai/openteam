import { servePlugin, tool, string, segment, type Tool } from '../../_shared/google';
export function oneDriveTools(token=process.env.MICROSOFT_ACCESS_TOKEN,fetcher:typeof fetch=fetch):Tool[]{
  const request=async(path:string)=>{if(!token)throw new Error('Authenticate OneDrive first');const response=await fetcher(`https://graph.microsoft.com/v1.0${path}`,{headers:{authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(30_000)});if(!response.ok)throw new Error(`OneDrive returned ${response.status}`);return response.json();};
  const fields='id,name,size,file,folder,parentReference,webUrl,lastModifiedDateTime';
  return [
    tool('get_profile','Identify the connected Microsoft account.',{},[],()=>request('/me?$select=id,displayName,mail,userPrincipalName')),
    tool('list_drive_items','List files in a OneDrive folder. Use upload_file and download_file for bytes.',{folderId:string('Folder ID; omitted uses root'),pageToken:string('Opaque nextLink from a previous result')},[],async a=>{
      let route=a.folderId?`/me/drive/items/${segment(a.folderId)}/children`:'/me/drive/root/children';
      if(a.pageToken){const url=new URL(a.pageToken);if(url.origin!=='https://graph.microsoft.com'||!url.pathname.startsWith('/v1.0/me/drive/')||!url.pathname.endsWith('/children'))throw new Error('Invalid OneDrive page token');route=url.pathname.slice('/v1.0'.length)+url.search;}
      else route+=`?$select=${fields}&$top=100`;return request(route);
    }),
    tool('get_drive_item','Get file/folder metadata by provider ID.',{fileId:string('Item ID')},['fileId'],a=>request(`/me/drive/items/${segment(a.fileId)}?$select=${fields}`)),
    tool('search_drive_items','Search filenames and indexed content in OneDrive.',{query:string('Search query')},['query'],a=>request(`/me/drive/root/search(q='${encodeURIComponent(a.query.replaceAll("'","''"))}')?$select=${fields}&$top=100`)),
  ];
}
if(import.meta.main)await servePlugin('openteam-onedrive',oneDriveTools());
