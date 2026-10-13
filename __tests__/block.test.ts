import { expect, test, vi } from 'vitest';
import {
  LessonRestrictionLevel,
  lessonRestrictionView,
  lessonView,
} from '@/lib/owaClient';
import { getLessonsRestrictions, isLessonRestricted } from '@/lib/queryGate';
import manualRestrictedLessonSlugs from '@/lib/queryGateData/assetTypeRestrictionsByLesson.json' with { type: 'json' };
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

  const result = await isLessonRestricted(client, 'restricted-lesson', 'video');

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

  const result = await isLessonRestricted(
    client,
    'ogl-equivalent-lesson',
    'video',
  );

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

  // the lesson's own levels are all OGL compatible, so the subject is the only
  // thing that can block it. The reason is deliberately vague and says nothing
  // about which of the two it was.
  expect(result.isBlocked()).toBe(true);
  expect(result.reason).toContain('not currently available');
});

// TEMP-TPC-GATE: asserted `isLessonRestricted(art, 'worksheet')` was allowed,
// back when art restricted only video and transcripts. Geography is the one
// subject that still leaves an asset type out, so it carries the behaviour.
test('isLessonRestricted allows the asset types a subject does not restrict', async () => {
  const result = await isLessonRestricted(
    subjectClient('geography-lesson', 'geography'),
    'geography-lesson',
    'transcript',
  );

  expect(result.isAllowed()).toBe(true);
});

// TEMP-TPC-GATE: used music, which restricted slide decks but not video.
// Music now restricts every asset type, so geography stands in for the
// per-type half of this and maths for the per-subject half.
test('isLessonRestricted restricts asset types per subject, not across subjects', async () => {
  const geography = subjectClient('geography-lesson', 'geography');

  await expect(
    isLessonRestricted(geography, 'geography-lesson', 'slideDeck').then(
      (gate) => gate.isBlocked(),
    ),
  ).resolves.toBe(true);

  await expect(
    isLessonRestricted(geography, 'geography-lesson', 'transcript').then(
      (gate) => gate.isBlocked(),
    ),
  ).resolves.toBe(false);

  await expect(
    isLessonRestricted(
      subjectClient('maths-lesson', 'maths'),
      'maths-lesson',
      'slideDeck',
    ).then((gate) => gate.isBlocked()),
  ).resolves.toBe(false);
});

// TEMP-TPC-GATE: was 'blocks a restricted subject when no asset type is
// given', from when the asset type was optional and omitting it meant "any
// restriction at all applies". The asset type is now required, and a wholly
// restricted subject restricts every one of them.
test('isLessonRestricted blocks every asset type of a wholly restricted subject', async () => {
  for (const assetType of [
    'video',
    'transcript',
    'quiz',
    'worksheet',
  ] as const) {
    const result = await isLessonRestricted(
      subjectClient('re-lesson', 'religious-education'),
      're-lesson',
      assetType,
    );

    expect(result.isBlocked()).toBe(true);
    expect(result.reason).toContain('not currently available');
  }
});

// TEMP-TPC-GATE: asserted the subject was never queried for 'quiz', because
// no subject restricted quizzes and the gate skipped the lookup. Quizzes are
// now restricted like everything else, so the lookup always happens.
test('isLessonRestricted queries the subject for every asset type', async () => {
  const { client, request } = countedClient(
    subjectResponses('art-lesson', 'art'),
  );

  const result = await isLessonRestricted(client, 'art-lesson', 'quiz');

  expect(result.isBlocked()).toBe(true);
  expect(request).toHaveBeenCalledTimes(2);
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

// TEMP-TPC-GATE: was 'restricts every asset type when given none'. Omitting
// the asset type used to mean "any restriction at all applies"; it now falls
// back to video, which art restricts either way.
test('getLessonsRestrictions falls back to video when given no asset type', async () => {
  const client = mockClient({
    [lessonRestrictionView]: [
      { ...oglCompatible, slug: 'art-lesson' },
      { ...oglCompatible, slug: 'geography-lesson' },
    ],
    [lessonView]: [
      { lessonSlug: 'art-lesson', subjectSlug: 'art' },
      { lessonSlug: 'geography-lesson', subjectSlug: 'geography' },
    ],
  });

  await expect(
    getLessonsRestrictions(client, ['art-lesson', 'geography-lesson']),
  ).resolves.toStrictEqual({
    'art-lesson': true,
    'geography-lesson': true,
  });
});

// TEMP-TPC-GATE: asserted the subject was never queried for 'quiz' and that
// the art lesson came back unrestricted. Both have changed; see the sibling
// isLessonRestricted test above.
test('getLessonsRestrictions queries subjects for every asset type', async () => {
  const { client, request } = countedClient(
    subjectResponses('art-lesson', 'art'),
  );

  await expect(
    getLessonsRestrictions(client, ['art-lesson'], 'quiz'),
  ).resolves.toStrictEqual({ 'art-lesson': true });

  expect(request).toHaveBeenCalledTimes(2);
});

// TEMP-TPC-GATE: delete these two along with
// `assetTypeRestrictionsByLesson.json`. They read the first slug off the list
// rather than naming one, so they keep testing the list as it shrinks.
test('isLessonRestricted blocks a lesson on the hard-coded list whatever its subject', async () => {
  const [slug] = manualRestrictedLessonSlugs;
  const { client, request } = countedClient(subjectResponses(slug, 'maths'));

  const result = await isLessonRestricted(client, slug, 'worksheet');

  expect(result.isBlocked()).toBe(true);
  // the list settles it, so there is no subject to look up
  expect(request).toHaveBeenCalledTimes(0);
});

test('getLessonsRestrictions blocks lessons on the hard-coded list', async () => {
  const [slug] = manualRestrictedLessonSlugs;
  const client = mockClient({
    [lessonRestrictionView]: [
      { ...oglCompatible, slug },
      { ...oglCompatible, slug: 'maths-lesson' },
    ],
    [lessonView]: [{ lessonSlug: 'maths-lesson', subjectSlug: 'maths' }],
  });

  await expect(
    getLessonsRestrictions(client, [slug, 'maths-lesson'], 'worksheet'),
  ).resolves.toStrictEqual({
    [slug]: true,
    'maths-lesson': false,
  });
});
