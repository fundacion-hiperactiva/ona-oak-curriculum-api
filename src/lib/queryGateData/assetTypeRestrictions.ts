/**
 * TEMP-TPC-GATE
 *
 * A temporary, hand-maintained layer over the third-party content (TPC) gate,
 * in place until the restriction levels in `lessonRestrictionView` are
 * trustworthy on their own. It restricts more than the data does, in two ways:
 *
 * 1. `assetTypeRestrictionsByLesson.json` — an explicit list of lesson slugs
 *    that are restricted whatever their subject says.
 * 2. `restrictedSubjectsMap` — whole subjects restricted across (nearly) every
 *    asset type, rather than the narrow per-type restrictions we had before.
 *
 * Both are expected to shrink and then go. To unwind, in this order:
 *
 * - Shrink or delete `assetTypeRestrictionsByLesson.json`. When it is empty,
 *   drop the lookup in `getAssetRestrictionsForLessons` and the JSON import.
 * - Narrow `restrictedSubjectsMap` back towards the per-type restrictions it
 *   replaced, which were:
 *     art:                 ['video', 'transcript']
 *     music:               ['slideDeck']
 *     religious-education: ['video', 'transcript']
 *     geography:           (not restricted at all)
 * - A caller with no asset type to give falls back to one rather than meaning
 *   "every type", which is what it used to mean: the `assetType || 'video'` in
 *   `queryGate.ts` and `assets.ts`. Revisit those as the map narrows, since
 *   video stops standing in for the rest.
 * - Restore the per-type assertions in `__tests__/block.test.ts`,
 *   `__tests__/search-transcripts.test.ts`,
 *   `__tests__/programme-assets-and-questions.test.ts` and
 *   `__tests__/check-restricted.test.ts`. Every assertion this layer changed
 *   carries a `TEMP-TPC-GATE` comment recording what it asserted before, so
 *   `grep -rn TEMP-TPC-GATE` finds the whole set.
 */
import z from 'zod';
import { downloadTypeEnum } from '@/lib/handlers/assets/types';
import type { CollapsedRestrictionStatus } from '@/lib/queryGate';
import manualRestrictedLessonSlugs from './assetTypeRestrictionsByLesson.json' with { type: 'json' };
import { gql, GraphQLClient } from 'graphql-request';
import { LessonView, lessonView } from '@/lib/owaClient';

/**
 * The asset types the gate can be asked about: anything downloadable, plus the
 * transcript and the quiz, which are served by endpoints of their own.
 */
const gatedAssetTypes = z.enum([
  ...downloadTypeEnum.options,
  'transcript',
  'quiz',
]);
export type GatedAssetType = z.infer<typeof gatedAssetTypes>;

/**
 * Subjects where third-party content is restricted across a whole asset type,
 * irrespective of an individual lesson's restriction levels.
 *
 * TEMP-TPC-GATE: deliberately blunt — see the note at the top of this file for
 * the narrower per-type restrictions these entries replaced.
 */
const restrictedSubjectsMap = new Map<string, GatedAssetType[]>([
  ['art', gatedAssetTypes.options],
  ['music', gatedAssetTypes.options],
  ['religious-education', gatedAssetTypes.options],
  ['geography', gatedAssetTypes.exclude(['transcript']).options],
]);

export async function getAssetRestrictionsForLesson(
  client: GraphQLClient,
  lessonSlug: string,
  assetType: GatedAssetType,
): Promise<CollapsedRestrictionStatus> {
  const res = await getAssetRestrictionsForLessons(
    client,
    [lessonSlug],
    assetType,
  );
  return res.get(lessonSlug) || 'ogl-compatible';
}

export async function getAssetRestrictionsForLessons(
  client: GraphQLClient,
  lessonSlugs: string[],
  assetType: GatedAssetType,
): Promise<Map<string, CollapsedRestrictionStatus>> {
  const res = new Map<string, CollapsedRestrictionStatus>();

  const toCheck = new Set(lessonSlugs);

  // TEMP-TPC-GATE: first filter all those that are in the hard coded list
  for (const lessonSlug of lessonSlugs) {
    if (manualRestrictedLessonSlugs.includes(lessonSlug)) {
      res.set(lessonSlug, 'restricted');
      toCheck.delete(lessonSlug);
    }
  }

  // then for the lessons that remain, we'll check them against the subject
  const lessonSubjects = toCheck.size
    ? await getLessonSubjectSlugs(client, Array.from(toCheck))
    : new Map<string, string>();

  for (const [lessonSlug, subject] of lessonSubjects) {
    const restrictions = restrictedSubjectsMap.get(subject);
    if (restrictions && restrictions.includes(assetType)) {
      res.set(lessonSlug, 'restricted');
    } else {
      res.set(lessonSlug, 'ogl-compatible');
    }

    toCheck.delete(lessonSlug);
  }

  // in reality there should be nothing in toCheck, but belt and braces
  // though I'd like to validate this code, the cost is nano seconds
  for (const lessonSlug of toCheck) {
    res.set(lessonSlug, 'ogl-compatible');
  }

  return res;
}

/** The subject slug of each of the given lessons that has one. */
async function getLessonSubjectSlugs(
  client: GraphQLClient,
  lessonSlugs: string[],
): Promise<Map<string, string>> {
  const query = gql`
  query ($slugs: [String!]!) @cached(ttl: 300) {
    ${lessonView}(
      where: { lessonSlug: { _in: $slugs }, isLegacy: { _eq: false } }
      distinct_on: lessonSlug
    ) {
      lessonSlug
      subjectSlug
    }
  }
  `;

  const res: LessonView = await client.request(query, { slugs: lessonSlugs });

  const subjectSlugsByLesson = new Map<string, string>();

  for (const lesson of res[lessonView] ?? []) {
    if (lesson.lessonSlug && lesson.subjectSlug) {
      subjectSlugsByLesson.set(lesson.lessonSlug, lesson.subjectSlug);
    }
  }

  return subjectSlugsByLesson;
}
