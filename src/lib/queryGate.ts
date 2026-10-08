import { gql } from 'graphql-request';
import type { GraphQLClient } from 'graphql-request';
import {
  LessonRestrictionLevel,
  type LessonRestrictionView,
  lessonRestrictionView,
  lessonView,
  type LessonView,
} from './owaClient';
import { subjectSlugs } from './keyStageAndSubjects';
import { childSubjects } from './oakConsts';
import type { DownloadTypeEnum } from '@/lib/handlers/assets/types';

const commonError =
  'Learn more about Oak errors: https://open-api.thenational.academy/docs/about-oaks-api/errors';

export const collapsedRestrictionStatuses = [
  'ogl-compatible',
  'restricted',
] as const;

export type CollapsedRestrictionStatus =
  (typeof collapsedRestrictionStatuses)[number];

// Custom result class that requires explicit narrowing via type guards
class GateWithReason {
  readonly blocked: boolean;
  readonly reason: string;

  constructor(blocked: boolean, reason = '') {
    this.blocked = blocked;
    this.reason = reason;
  }

  toString() {
    return this.reason || String(this.blocked);
  }

  isAllowed(): this is GateWithReason & { blocked: false } {
    return this.blocked === false;
  }

  isBlocked(): this is GateWithReason & { blocked: true } {
    return this.blocked === true;
  }
}

export function isRestricted(
  restriction: LessonRestrictionLevel | undefined,
): boolean {
  return (
    restriction === LessonRestrictionLevel.RESTRICTED ||
    restriction === LessonRestrictionLevel.HIGHLY_RESTRICTED
  );
}

export function highestRestrictionLevel(
  restrictions: (LessonRestrictionLevel | null | undefined)[],
): LessonRestrictionLevel {
  return (
    [
      LessonRestrictionLevel.HIGHLY_RESTRICTED,
      LessonRestrictionLevel.RESTRICTED,
      LessonRestrictionLevel.OGL_COMPATIBLE,
      LessonRestrictionLevel.OGL_EQUIVALENT,
    ].find((level) => restrictions.includes(level)) ??
    LessonRestrictionLevel.OGL_COMPATIBLE
  );
}

export function collapsedRestrictionStatus(
  restriction: LessonRestrictionLevel,
): CollapsedRestrictionStatus {
  switch (restriction) {
    case LessonRestrictionLevel.RESTRICTED:
    case LessonRestrictionLevel.HIGHLY_RESTRICTED:
      return 'restricted';
    default:
      return 'ogl-compatible';
  }
}

export function isSubjectAllowed(subject: string): boolean {
  const allowed = [...subjectSlugs, ...childSubjects];
  return allowed.includes(subject);
}

/**
 * The asset types the gate can be asked about: anything downloadable, plus the
 * transcript and the quiz, which are served by endpoints of their own.
 */
export type GatedAssetType = DownloadTypeEnum | 'transcript' | 'quiz';

/**
 * Subjects where third-party content is restricted across a whole asset type,
 * irrespective of an individual lesson's restriction levels.
 */
const restrictedSubjectsMap = new Map<string, GatedAssetType[]>([
  ['art', ['video', 'transcript']],
  ['music', ['slideDeck']],
  ['religious-education', ['video', 'transcript']],
]);

const subjectRestrictedAssetTypes = new Set<GatedAssetType>(
  [...restrictedSubjectsMap.values()].flat(),
);

/**
 * Whether any subject restricts this asset type, so we only go looking for a
 * lesson's subject when the answer could matter.
 */
function canBeSubjectRestricted(assetType?: GatedAssetType): boolean {
  return !assetType || subjectRestrictedAssetTypes.has(assetType);
}

/**
 * Without an asset type, every asset type is in scope, so any subject-level
 * restriction at all applies.
 */
function isRestrictedBySubject(
  subjectSlug: string | undefined,
  assetType?: GatedAssetType,
): boolean {
  const restrictedAssetTypes = subjectSlug
    ? restrictedSubjectsMap.get(subjectSlug)
    : undefined;

  if (!restrictedAssetTypes) {
    return false;
  }

  return !assetType || restrictedAssetTypes.includes(assetType);
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

export async function getLessonsRestrictions(
  client: GraphQLClient,
  lessonSlugs: string[],
  assetType?: GatedAssetType,
): Promise<Record<string, boolean>> {
  const query = gql`
  query ($slugs: [String!]!) @cached(ttl: 300) {
    ${lessonRestrictionView}(
      where: { _state:{_eq:"published"}, slug: { _in: $slugs } }
    ) {
      slug
      tpc_downloadablefiles_max_restriction
      tpc_media_max_restriction
      tpc_quizimages_max_restriction
      tpc_works_max_restriction
    }
  }
  `;

  // the two views are independent, so don't pay for them one after the other
  const restrictions: Promise<LessonRestrictionView> = client.request(query, {
    slugs: lessonSlugs,
  });

  const [res, subjectSlugsByLesson] = await Promise.all([
    restrictions,
    canBeSubjectRestricted(assetType)
      ? getLessonSubjectSlugs(client, lessonSlugs)
      : new Map<string, string>(),
  ]);

  const result: Record<string, boolean> = {};

  for (const lesson of res[lessonRestrictionView]) {
    result[lesson.slug] =
      isRestrictedBySubject(subjectSlugsByLesson.get(lesson.slug), assetType) ||
      isRestricted(
        highestRestrictionLevel([
          lesson.tpc_downloadablefiles_max_restriction,
          lesson.tpc_media_max_restriction,
          lesson.tpc_quizimages_max_restriction,
          lesson.tpc_works_max_restriction,
        ]),
      );
  }

  return result;
}

export async function isLessonRestricted(
  client: GraphQLClient,
  lessonSlug: string,
  assetType?: GatedAssetType,
): Promise<GateWithReason> {
  const query = gql`
  query ($slug: String!) {
    ${lessonRestrictionView}(
      where: { _state:{_eq:"published"}, slug: { _eq: $slug } }
    ) {
      tpc_downloadablefiles_max_restriction
      tpc_media_max_restriction
      tpc_quizimages_max_restriction
      tpc_works_max_restriction
    }
  }
  `;

  const res: LessonRestrictionView = await client.request(query, {
    slug: lessonSlug,
  });

  if (!res[lessonRestrictionView].length) {
    return new GateWithReason(false, 'Lesson not in restrictions');
  }

  if (canBeSubjectRestricted(assetType)) {
    const subjectSlugsByLesson = await getLessonSubjectSlugs(client, [
      lessonSlug,
    ]);

    if (
      isRestrictedBySubject(subjectSlugsByLesson.get(lessonSlug), assetType)
    ) {
      return new GateWithReason(
        true,
        'Lesson contains restricted content at the subject level, and therefore blocked. ' +
          commonError,
      );
    }
  }

  const restriction = res[lessonRestrictionView][0];

  const isAnyRestricted = isRestricted(
    highestRestrictionLevel([
      restriction.tpc_downloadablefiles_max_restriction,
      restriction.tpc_media_max_restriction,
      restriction.tpc_quizimages_max_restriction,
      restriction.tpc_works_max_restriction,
    ]),
  );

  return new GateWithReason(
    isAnyRestricted,
    isAnyRestricted
      ? 'Lesson contains restricted content and therefore blocked. ' +
          commonError
      : 'Lesson does not contain restricted content',
  );
}
