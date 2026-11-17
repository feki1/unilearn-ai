import { parseMultipartFormData } from '../catalog/ingestionService.js';
import {
  deleteProvider,
  listProviders,
  testProvider,
  updateProvider,
  upsertProvider
} from './providerRegistry.js';
import {
  createConversation,
  getConversationDetail,
  listConversations,
  sendChatMessage,
  uploadChatFile
} from './chatService.js';

export function createAiHubRouter({ db }) {
  return async function handleAiHubRoute(req, res) {
    const { method, pathname, query } = req;
    const userId = req.auth?.student?.id;

    try {
      // Providers
      if (method === 'GET' && pathname === '/api/ai/providers') {
        res.json(200, listProviders(db, userId));
        return true;
      }

      if (method === 'POST' && pathname === '/api/ai/providers') {
        const provider = upsertProvider(db, userId, req.body || {});
        res.json(201, { provider });
        return true;
      }

      const providerTestMatch = pathname.match(/^\/api\/ai\/providers\/([^/]+)\/test$/);
      if (method === 'POST' && providerTestMatch) {
        const result = await testProvider(db, userId, decodeURIComponent(providerTestMatch[1]));
        res.json(200, result);
        return true;
      }

      const providerIdMatch = pathname.match(/^\/api\/ai\/providers\/([^/]+)$/);
      if (providerIdMatch) {
        const providerId = decodeURIComponent(providerIdMatch[1]);
        if (method === 'PUT' || method === 'PATCH') {
          const provider = updateProvider(db, userId, providerId, req.body || {});
          res.json(200, { provider });
          return true;
        }
        if (method === 'DELETE') {
          res.json(200, deleteProvider(db, userId, providerId));
          return true;
        }
      }

      // Conversations (plus /api/ai/chat/threads aliases)
      if (
        method === 'GET' &&
        (pathname === '/api/ai/conversations' || pathname === '/api/ai/chat/threads')
      ) {
        res.json(200, {
          conversations: listConversations(db, userId, { subjectId: query.subjectId || '' })
        });
        return true;
      }

      if (
        method === 'POST' &&
        (pathname === '/api/ai/conversations' || pathname === '/api/ai/chat/threads')
      ) {
        const conversation = createConversation(db, userId, req.body || {});
        res.json(201, { conversation });
        return true;
      }

      const convFilesMatch = pathname.match(/^\/api\/ai\/conversations\/([^/]+)\/files$/);
      if (
        method === 'POST' &&
        (convFilesMatch || pathname === '/api/ai/files/upload')
      ) {
        const contentType = String(req.headers['content-type'] || '').toLowerCase();
        let payload = { ...(req.body || {}) };
        if (contentType.includes('multipart/form-data')) {
          const parsed = parseMultipartFormData(req.rawBody, req.headers['content-type']);
          const uploaded = parsed.files[0];
          payload = {
            ...parsed.fields,
            filename: uploaded?.filename || parsed.fields.filename || 'chat-file.txt',
            mimeType: uploaded?.mimeType || parsed.fields.mimeType || '',
            buffer: uploaded?.buffer || null
          };
        }
        const convId = convFilesMatch
          ? decodeURIComponent(convFilesMatch[1])
          : payload.conversationId || null;

        const chatFile = uploadChatFile(db, userId, convId, payload);
        res.json(201, { chatFile });
        return true;
      }

      const convMessagesMatch = pathname.match(/^\/api\/ai\/conversations\/([^/]+)\/messages$/);
      if (
        method === 'POST' &&
        (convMessagesMatch || pathname === '/api/ai/chat/messages')
      ) {
        const convId = convMessagesMatch
          ? decodeURIComponent(convMessagesMatch[1])
          : req.body?.conversationId;
        const result = await sendChatMessage(db, userId, convId, req.body || {});
        res.json(201, result);
        return true;
      }

      const convDetailMatch = pathname.match(/^\/api\/ai\/(?:conversations|chat\/threads)\/([^/]+)$/);
      if (method === 'GET' && convDetailMatch) {
        const detail = getConversationDetail(db, userId, decodeURIComponent(convDetailMatch[1]));
        res.json(200, detail);
        return true;
      }

      return false;
    } catch (err) {
      res.json(err.statusCode || 500, {
        error: err.message || 'AI Hub error',
        code: err.code || 'AI_HUB_ERROR'
      });
      return true;
    }
  };
}

export default createAiHubRouter;
