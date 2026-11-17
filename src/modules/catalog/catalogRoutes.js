import {
  createLesson,
  createMajor,
  createSubject,
  getFileDetail,
  getLessonDetail,
  getOverview,
  getSubjectDetail,
  listFiles,
  listMajors,
  listSubjects
} from './catalogService.js';
import {
  ingestCourseFile,
  parseMultipartFormData,
  searchCourseChunks
} from './ingestionService.js';

export function createCatalogRouter({ db, dataDir }) {
  return async function handleCatalogRoute(req, res) {
    const { method, pathname, query } = req;

    try {
      if (method === 'GET' && pathname === '/api/catalog/overview') {
        res.json(200, getOverview(db));
        return true;
      }

      if (method === 'GET' && pathname === '/api/catalog/majors') {
        res.json(200, { majors: listMajors(db) });
        return true;
      }

      if (method === 'POST' && pathname === '/api/catalog/majors') {
        const major = createMajor(db, req.body || {});
        res.json(201, { major });
        return true;
      }

      if (method === 'GET' && pathname === '/api/catalog/subjects') {
        res.json(200, {
          subjects: listSubjects(db, {
            majorId: query.majorId || '',
            q: query.q || ''
          })
        });
        return true;
      }

      if (method === 'POST' && pathname === '/api/catalog/subjects') {
        const subject = createSubject(db, req.body || {});
        res.json(201, { subject });
        return true;
      }

      const subjectLessonsMatch = pathname.match(/^\/api\/catalog\/subjects\/([^/]+)\/lessons$/);
      if (method === 'POST' && subjectLessonsMatch) {
        const result = createLesson(
          db,
          decodeURIComponent(subjectLessonsMatch[1]),
          req.body || {},
          req.auth?.student?.id || 'student'
        );
        res.json(201, result);
        return true;
      }

      const subjectMatch = pathname.match(/^\/api\/catalog\/subjects\/([^/]+)$/);
      if (method === 'GET' && subjectMatch) {
        res.json(200, getSubjectDetail(db, decodeURIComponent(subjectMatch[1])));
        return true;
      }

      const lessonMatch = pathname.match(/^\/api\/catalog\/lessons\/([^/]+)$/);
      if (method === 'GET' && lessonMatch) {
        res.json(200, getLessonDetail(db, decodeURIComponent(lessonMatch[1])));
        return true;
      }

      if (
        method === 'POST' &&
        (pathname === '/api/catalog/files/upload' || pathname === '/api/catalog/ingest')
      ) {
        const contentType = String(req.headers['content-type'] || '').toLowerCase();
        let payload = { ...(req.body || {}) };

        if (contentType.includes('multipart/form-data')) {
          const parsed = parseMultipartFormData(req.rawBody, req.headers['content-type']);
          const uploaded = parsed.files[0];
          payload = {
            ...parsed.fields,
            filename: uploaded?.filename || parsed.fields.filename || 'uploaded.txt',
            mimeType: uploaded?.mimeType || parsed.fields.mimeType || '',
            buffer: uploaded?.buffer || null
          };
        }

        const result = ingestCourseFile(db, dataDir, {
          ...payload,
          uploadedBy: req.auth?.student?.id || 'student',
          scope: payload.scope || 'student'
        });
        res.json(201, result);
        return true;
      }

      if (method === 'GET' && pathname === '/api/catalog/files') {
        res.json(200, {
          files: listFiles(db, {
            subjectId: query.subjectId || '',
            majorId: query.majorId || ''
          })
        });
        return true;
      }

      const fileMatch = pathname.match(/^\/api\/catalog\/files\/([^/]+)$/);
      if (method === 'GET' && fileMatch) {
        res.json(200, getFileDetail(db, decodeURIComponent(fileMatch[1])));
        return true;
      }

      if (method === 'GET' && pathname === '/api/catalog/search') {
        const results = searchCourseChunks(db, {
          q: query.q || '',
          majorId: query.majorId || '',
          subjectId: query.subjectId || '',
          limit: query.limit || 20
        });
        res.json(200, { results });
        return true;
      }

      return false;
    } catch (err) {
      res.json(err.statusCode || 500, {
        error: err.message || 'Catalog error',
        code: err.code || 'CATALOG_ERROR'
      });
      return true;
    }
  };
}

export default createCatalogRouter;
