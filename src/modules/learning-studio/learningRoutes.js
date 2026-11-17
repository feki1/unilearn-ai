import {
  deleteSlideDeck,
  generateSlideDeck,
  getSlideDeck,
  listSlideDecks,
  updateSlideDeck
} from './slideGeneratorService.js';
import {
  generateExam,
  generateFlashcards,
  generateStudyGuide,
  getExam,
  getExamPrepOverview,
  listAttempts,
  listExams,
  listFlashcards,
  listStudyGuides,
  reviewFlashcard,
  submitExam
} from './examPrepService.js';

export function createLearningRouter({ db }) {
  return async function handleLearningRoute(req, res) {
    const { method, pathname, query } = req;
    const userId = req.auth?.student?.id;

    try {
      // Slide Decks
      if (method === 'GET' && (pathname === '/api/slides' || pathname === '/api/learning/slides')) {
        res.json(200, {
          slideDecks: listSlideDecks(db, {
            subjectId: query.subjectId || '',
            lessonId: query.lessonId || ''
          })
        });
        return true;
      }

      if (
        method === 'POST' &&
        (pathname === '/api/slides/generate' || pathname === '/api/learning/slides/generate')
      ) {
        const deck = generateSlideDeck(db, userId, req.body || {});
        res.json(201, { deck });
        return true;
      }

      const slideDeckMatch = pathname.match(/^\/api\/(?:slides|learning\/slides)\/([^/]+)$/);
      if (slideDeckMatch) {
        const deckId = decodeURIComponent(slideDeckMatch[1]);
        if (method === 'GET') {
          res.json(200, { deck: getSlideDeck(db, deckId) });
          return true;
        }
        if (method === 'PUT' || method === 'PATCH') {
          res.json(200, { deck: updateSlideDeck(db, deckId, req.body || {}) });
          return true;
        }
        if (method === 'DELETE') {
          res.json(200, deleteSlideDeck(db, deckId));
          return true;
        }
      }

      // Exam Prep Overview
      if (method === 'GET' && pathname === '/api/exam-prep/overview') {
        res.json(200, getExamPrepOverview(db, userId, { subjectId: query.subjectId || '' }));
        return true;
      }

      // Flashcards
      if (method === 'GET' && pathname === '/api/exam-prep/flashcards') {
        res.json(200, {
          flashcards: listFlashcards(db, {
            subjectId: query.subjectId || '',
            dueOnly: query.dueOnly || false
          })
        });
        return true;
      }

      if (method === 'POST' && pathname === '/api/exam-prep/flashcards/generate') {
        const flashcards = generateFlashcards(db, req.body || {});
        res.json(201, { flashcards });
        return true;
      }

      const cardReviewMatch = pathname.match(/^\/api\/exam-prep\/flashcards\/([^/]+)\/review$/);
      if (method === 'POST' && cardReviewMatch) {
        const flashcard = reviewFlashcard(
          db,
          decodeURIComponent(cardReviewMatch[1]),
          req.body?.quality
        );
        res.json(200, { flashcard });
        return true;
      }

      // Exams & Quizzes
      if (method === 'GET' && (pathname === '/api/exam-prep/exams' || pathname === '/api/learning/exams')) {
        res.json(200, {
          exams: listExams(db, {
            subjectId: query.subjectId || '',
            mode: query.mode || ''
          })
        });
        return true;
      }

      if (
        method === 'POST' &&
        (pathname === '/api/exam-prep/exams/generate' || pathname === '/api/learning/exams/generate')
      ) {
        const exam = generateExam(db, req.body || {});
        res.json(201, { exam });
        return true;
      }

      const examSubmitMatch = pathname.match(/^\/api\/(?:exam-prep|learning)\/exams\/([^/]+)\/submit$/);
      if (method === 'POST' && examSubmitMatch) {
        const attempt = submitExam(
          db,
          userId,
          decodeURIComponent(examSubmitMatch[1]),
          req.body || {}
        );
        res.json(201, { attempt });
        return true;
      }

      const examDetailMatch = pathname.match(/^\/api\/(?:exam-prep|learning)\/exams\/([^/]+)$/);
      if (method === 'GET' && examDetailMatch) {
        res.json(200, { exam: getExam(db, decodeURIComponent(examDetailMatch[1])) });
        return true;
      }

      if (method === 'GET' && pathname === '/api/exam-prep/attempts') {
        res.json(200, {
          attempts: listAttempts(db, userId, { subjectId: query.subjectId || '' })
        });
        return true;
      }

      // Study Guides
      if (method === 'POST' && pathname === '/api/exam-prep/study-guides/generate') {
        const studyGuide = generateStudyGuide(db, userId, req.body || {});
        res.json(201, { studyGuide });
        return true;
      }

      if (method === 'GET' && pathname === '/api/exam-prep/study-guides') {
        res.json(200, {
          studyGuides: listStudyGuides(db, userId, { subjectId: query.subjectId || '' })
        });
        return true;
      }

      return false;
    } catch (err) {
      res.json(err.statusCode || 500, {
        error: err.message || 'Learning studio error',
        code: err.code || 'LEARNING_STUDIO_ERROR'
      });
      return true;
    }
  };
}

export default createLearningRouter;
