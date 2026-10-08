import { expect, test, vi } from 'vitest';
import {
  LessonRestrictionLevel,
  lessonRestrictionView,
  lessonView,
} from '@/lib/owaClient';
import { getLessonsRestrictions, isLessonRestricted } from '@/lib/queryGate';
import type { GraphQLClient } from 'graphql-request';

/**
 * Responds per view: the gate queries the restriction levels and, when a
 * subject-level restriction could apply, the lesson's subject.
 */
function mockRequest(responses: Record<string, unknown>) {
  return vi.fn((query: string) => {
    const view = Object.keys(responses).find((name) => query.includes(name));
    return view ? { [view]: responses[view] } : {};
  });
}

function mockClient(responses: Record<string, unknown>): GraphQLClient {
  return { request: mockRequest(responses) } as unknown as GraphQLClient;
}

/** The request spy alongside its client, for the tests that count queries. */
function countedClient(responses: Record<string, unknown>) {
  const request = mockRequest(responses);

  return { client: { request } as unknown as GraphQLClient, request };
}

const oglCompatible = {
  tpc_downloadablefiles_max_restriction: LessonRestrictionLevel.OGL_COMPATIBLE,
  tpc_media_max_restriction: LessonRestrictionLevel.OGL_COMPATIBLE,
  tpc_quizimages_max_restriction: LessonRestrictionLevel.OGL_COMPATIBLE,
  tpc_works_max_restriction: LessonRestrictionLevel.OGL_COMPATIBLE,
};

function subjectResponses(lessonSlug: string, subjectSlug: string) {
  return {
    [lessonRestrictionView]: [{ ...oglCompatible, slug: lessonSlug }],
    [lessonView]: [{ lessonSlug, subjectSlug }],
  };
}

function subjectClient(lessonSlug: string, subjectSlug: string): GraphQLClient {
  return mockClient(subjectResponses(lessonSlug, subjectSlug));
}

test('isLessonRestricted blocks lessons with restricted content in any restriction field', async () => {
  const client = mockClient({
    [lessonRestrictionView]: [
      {
        ...oglCompatible,
        tpc_works_max_restriction: LessonRestrictionLevel.RESTRICTED,
      },
    ],
    [lessonView]: [{ lessonSlug: 'restricted-lesson', subjectSlug: 'maths' }],
  });

  const result = await isLessonRestricted(client, 'restricted-lesson');

  expect(result.isBlocked()).toBe(true);
  expect(result.reason).toContain('restricted content');
});

test('isLessonRestricted allows lessons with OGL compatible or equivalent restrictions', async () => {
  const client = mockClient({
    [lessonRestrictionView]: [
      {
        ...oglCompatible,
        tpc_downloadablefiles_max_restriction:
          LessonRestrictionLevel.OGL_EQUIVALENT,
      },
    ],
    [lessonView]: [
      { lessonSlug: 'ogl-equivalent-lesson', subjectSlug: 'maths' },
    ],
  });

  const result = await isLessonRestricted(client, 'ogl-equivalent-lesson');

  expect(result.isAllowed()).toBe(true);
});

test('getLessonsRestrictions returns true only for restricted lessons', async () => {
  const client = mockClient({
    [lessonRestrictionView]: [
      {
        slug: 'restricted-lesson',
        tpc_downloadablefiles_max_restriction:
          LessonRestrictionLevel.HIGHLY_RESTRICTED,
      },
      {
        slug: 'allowed-lesson',
        tpc_downloadablefiles_max_restriction:
          LessonRestrictionLevel.OGL_COMPATIBLE,
      },
    ],
  });

  await expect(
    getLessonsRestrictions(client, ['restricted-lesson', 'allowed-lesson']),
  ).resolves.toStrictEqual({
    'restricted-lesson': true,
    'allowed-lesson': false,
  });
});

test('isLessonRestricted blocks the asset types a subject restricts', async () => {
  const result = await isLessonRestricted(
    subjectClient('art-lesson', 'art'),
    'art-lesson',
    'video',
  );

  expect(result.isBlocked()).toBe(true);
  expect(result.reason).toContain('at the subject level');
});

test('isLessonRestricted allows the asset types a subject does not restrict', async () => {
  const result = await isLessonRestricted(
    subjectClient('art-lesson', 'art'),
    'art-lesson',
    'worksheet',
  );

  expect(result.isAllowed()).toBe(true);
});

test('isLessonRestricted restricts asset types per subject, not across subjects', async () => {
  const music = subjectClient('music-lesson', 'music');

  await expect(
    isLessonRestricted(music, 'music-lesson', 'slideDeck').then((gate) =>
      gate.isBlocked(),
    ),
  ).resolves.toBe(true);

  await expect(
    isLessonRestricted(music, 'music-lesson', 'video').then((gate) =>
      gate.isBlocked(),
    ),
  ).resolves.toBe(false);
});

test('isLessonRestricted blocks a restricted subject when no asset type is given', async () => {
  const result = await isLessonRestricted(
    subjectClient('re-lesson', 'religious-education'),
    're-lesson',
  );

  expect(result.isBlocked()).toBe(true);
  expect(result.reason).toContain('at the subject level');
});

test('isLessonRestricted does not query the subject for asset types no subject restricts', async () => {
  const { client, request } = countedClient(
    subjectResponses('art-lesson', 'art'),
  );

  const result = await isLessonRestricted(client, 'art-lesson', 'quiz');

  expect(result.isAllowed()).toBe(true);
  expect(request).toHaveBeenCalledTimes(1);
});

test('getLessonsRestrictions applies the subject-level restrictions too', async () => {
  const client = mockClient({
    [lessonRestrictionView]: [
      { ...oglCompatible, slug: 'art-lesson' },
      { ...oglCompatible, slug: 'maths-lesson' },
    ],
    [lessonView]: [
      { lessonSlug: 'art-lesson', subjectSlug: 'art' },
      { lessonSlug: 'maths-lesson', subjectSlug: 'maths' },
    ],
  });

  await expect(
    getLessonsRestrictions(client, ['art-lesson', 'maths-lesson'], 'video'),
  ).resolves.toStrictEqual({
    'art-lesson': true,
    'maths-lesson': false,
  });
});

test('getLessonsRestrictions restricts every asset type when given none', async () => {
  const client = mockClient({
    [lessonRestrictionView]: [{ ...oglCompatible, slug: 'art-lesson' }],
    [lessonView]: [{ lessonSlug: 'art-lesson', subjectSlug: 'art' }],
  });

  await expect(
    getLessonsRestrictions(client, ['art-lesson']),
  ).resolves.toStrictEqual({ 'art-lesson': true });
});

test('getLessonsRestrictions does not query subjects for asset types no subject restricts', async () => {
  const { client, request } = countedClient(
    subjectResponses('art-lesson', 'art'),
  );

  await expect(
    getLessonsRestrictions(client, ['art-lesson'], 'quiz'),
  ).resolves.toStrictEqual({ 'art-lesson': false });

  expect(request).toHaveBeenCalledTimes(1);
});
