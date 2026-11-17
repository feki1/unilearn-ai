import {
  exportResearch,
  getResearchProject,
  listResearchProjects,
  runResearch,
  updateResearchNotes
} from './researchService.js';
import {
  ensureMp4ForVideo,
  generateVideo,
  getVideo,
  listVideos,
  streamMp4Response
} from './videoGeneratorService.js';

export function createMediaRouter({ db, dataDir }) {
  return async function handleMediaRoute(req, res) {
    const { method, pathname, query } = req;
    const userId = req.auth?.student?.id;

    try {
      // Research Projects
      if (method === 'GET' && (pathname === '/api/research' || pathname === '/api/research/projects')) {
        res.json(200, {
          projects: listResearchProjects(db, userId, {
            subjectId: query.subjectId || '',
            majorId: query.majorId || ''
          })
        });
        return true;
      }

      if (method === 'POST' && pathname === '/api/research/run') {
        const project = runResearch(db, userId, req.body || {});
        res.json(201, { project });
        return true;
      }

      const researchNotesMatch = pathname.match(/^\/api\/research\/([^/]+)\/notes$/);
      if (method === 'PUT' && researchNotesMatch) {
        const project = updateResearchNotes(
          db,
          decodeURIComponent(researchNotesMatch[1]),
          req.body || {}
        );
        res.json(200, { project });
        return true;
      }

      const researchExportMatch = pathname.match(/^\/api\/research\/([^/]+)\/export$/);
      if (method === 'GET' && researchExportMatch) {
        const exported = exportResearch(
          db,
          decodeURIComponent(researchExportMatch[1]),
          query.format || 'json'
        );
        res.writeHead(200, {
          'Content-Type': exported.contentType,
          'Content-Disposition': `attachment; filename="${exported.filename}"`
        });
        res.end(exported.body);
        return true;
      }

      const researchDetailMatch = pathname.match(/^\/api\/research\/([^/]+)$/);
      if (method === 'GET' && researchDetailMatch) {
        res.json(200, { project: getResearchProject(db, decodeURIComponent(researchDetailMatch[1])) });
        return true;
      }

      // AI Videos
      if (method === 'GET' && (pathname === '/api/videos' || pathname === '/api/media/videos')) {
        res.json(200, {
          videos: listVideos(db, {
            subjectId: query.subjectId || '',
            lessonId: query.lessonId || ''
          })
        });
        return true;
      }

      if (
        method === 'POST' &&
        (pathname === '/api/videos/generate' || pathname === '/api/media/videos/generate')
      ) {
        const video = generateVideo(db, userId, dataDir, req.body || {});
        res.json(201, { video });
        return true;
      }

      const videoStreamMatch = pathname.match(
        /^\/api\/(?:videos|media\/videos)\/([^/]+)\/(?:stream|render)$/
      );
      if (method === 'GET' && videoStreamMatch) {
        const videoId = decodeURIComponent(videoStreamMatch[1]);
        const mp4Path = ensureMp4ForVideo(db, dataDir, videoId);
        streamMp4Response(req, res, mp4Path);
        return true;
      }

      const videoDetailMatch = pathname.match(/^\/api\/(?:videos|media\/videos)\/([^/]+)$/);
      if (method === 'GET' && videoDetailMatch) {
        res.json(200, { video: getVideo(db, decodeURIComponent(videoDetailMatch[1])) });
        return true;
      }

      return false;
    } catch (err) {
      res.json(err.statusCode || 500, {
        error: err.message || 'Research/Media error',
        code: err.code || 'MEDIA_ERROR'
      });
      return true;
    }
  };
}

export default createMediaRouter;
