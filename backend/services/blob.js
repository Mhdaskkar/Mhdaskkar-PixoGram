const { BlobServiceClient } = require('@azure/storage-blob');

const CONNECTION_STRING = process.env.STORAGE_CONNECTION_STRING;
const CONTAINER_NAME    = process.env.STORAGE_CONTAINER_NAME || 'photos';
const THUMB_CONTAINER   = process.env.STORAGE_THUMBNAIL_CONTAINER || 'thumbnails';

// Debug on startup
console.log('[blob.js] CONNECTION_STRING present:', !!CONNECTION_STRING);
console.log('[blob.js] CONTAINER_NAME:', CONTAINER_NAME);

let _client;

function getClient() {
  if (!CONNECTION_STRING) {
    throw new Error('STORAGE_CONNECTION_STRING is not set in environment variables');
  }
  if (!_client) _client = BlobServiceClient.fromConnectionString(CONNECTION_STRING);
  return _client;
}

async function uploadBuffer(blobName, buffer, contentType) {
  if (!buffer) throw new Error('uploadBuffer: buffer is undefined');
  console.log('[blob.js] Uploading:', blobName, 'size:', buffer.length);
  
  const isThumb = blobName.startsWith('thumbnails/');
  const containerName = isThumb ? THUMB_CONTAINER : CONTAINER_NAME;
  const cleanName = blobName.replace('thumbnails/', '').replace('originals/', '');
  
  const container = getClient().getContainerClient(containerName);
  const blockBlob = container.getBlockBlobClient(cleanName);
  
  await blockBlob.uploadData(buffer, {
    blobHTTPHeaders: { blobContentType: contentType },
  });
  
  console.log('[blob.js] Uploaded successfully:', blockBlob.url);
  return blockBlob.url;
}

async function deleteBlob(blobName) {
  const isThumb = blobName.startsWith('thumbnails/');
  const containerName = isThumb ? THUMB_CONTAINER : CONTAINER_NAME;
  const container = getClient().getContainerClient(containerName);
  const name = blobName.replace('thumbnails/', '').replace('originals/', '');
  await container.deleteBlob(name, { deleteSnapshots: 'include' });
}

module.exports = { uploadBuffer, deleteBlob };