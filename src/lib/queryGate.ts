import { gql } from 'graphql-request';
import type { GraphQLClient } from 'graphql-request';
import {
  LessonRestrictionLevel,
  type LessonRestrictionView,
  lessonRestrictionView,
} from './owaClient';
import { subjectSlugs } from './keyStageAndSubjects';
import { childSubjects } from './oakConsts';
import {
  type GatedAssetType,
  getAssetRestrictionsForLesson,
  getAssetRestrictionsForLessons,
} from './queryGateData/assetTypeRestrictions';

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
 * The restriction status of each of the given lessons, from the lesson's own
 * restriction levels and the layer over them. The single source of truth for
 * the gate's bulk answer: the asset endpoints read it as a boolean through
 * `getLessonsRestrictions`, and the check-restricted endpoints return it.
 *
 * Lessons with no published row in the restriction view are left out, unless
 * the layer restricts them.
 */
export async function getLessonsRestrictionStatuses(
  client: GraphQLClient,
  lessonSlugs: string[],
  assetType?: GatedAssetType,
): Promise<Record<string, CollapsedRestrictionStatus>> {
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

  const restrictions: LessonRestrictionView = await client.request(query, {
    slugs: lessonSlugs,
  });

  // TEMP-TPC-GATE: `assetType || 'video'` — see queryGateData/assetTypeRestrictions.ts
  const layerRestrictions = await getAssetRestrictionsForLessons(
    client,
    lessonSlugs,
    assetType || 'video',
  );

  const result: Record<string, CollapsedRestrictionStatus> = {};

  for (const lesson of restrictions[lessonRestrictionView]) {
    result[lesson.slug] = collapsedRestrictionStatus(
      highestRestrictionLevel([
        lesson.tpc_downloadablefiles_max_restriction,
        lesson.tpc_media_max_restriction,
        lesson.tpc_quizimages_max_restriction,
        lesson.tpc_works_max_restriction,
      ]),
    );
  }

  // the layer only ever restricts further, and it stands on its own: a lesson
  // it restricts stays restricted even with no row in the restriction view
  for (const [slug, status] of layerRestrictions) {
    if (status === 'restricted') {
      result[slug] = status;
    }
  }

  return result;
}

export async function getLessonsRestrictions(
  client: GraphQLClient,
  lessonSlugs: string[],
  assetType?: GatedAssetType,
): Promise<Record<string, boolean>> {
  const statuses = await getLessonsRestrictionStatuses(
    client,
    lessonSlugs,
    assetType,
  );

  return Object.fromEntries(
    Object.entries(statuses).map(([slug, status]) => [
      slug,
      status === 'restricted',
    ]),
  );
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

  if (
    (await getAssetRestrictionsForLesson(
      client,
      lessonSlug,
      assetType || 'video',
    )) === 'restricted'
  ) {
    // This error is apparently intentionally vague. See git blame for info
    return new GateWithReason(true, 'This is not currently available.');
  }

  const res: LessonRestrictionView = await client.request(query, {
    slug: lessonSlug,
  });

  if (!res[lessonRestrictionView].length) {
    return new GateWithReason(false, 'Lesson not in restrictions');
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
