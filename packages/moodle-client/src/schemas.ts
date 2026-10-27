import { z } from 'zod';

/*
 * Response schemas for the Moodle web-service functions this client calls.
 *
 * - Only fields the application uses (or may reasonably need) are declared. Zod strips
 *   undeclared keys, which also keeps unneeded personal data (addresses, phone numbers,
 *   profile fields) out of the application.
 * - Fields Moodle documents as always present are required; everything that varies by
 *   version, module type or capability is optional.
 * - Moodle encodes many flags as 0/1 integers; they are kept as numbers here and interpreted
 *   by the mapping layer (phase 3).
 */

const id = z.number().int().nonnegative();
const timestamp = z.number().int().nonnegative();
const flag = z.number().int().min(0).max(1);
/**
 * Moodle sends `null` for some optional strings (e.g. `filepath` on URL activities). They are
 * accepted and normalised to `undefined`, so consumers only ever see `string | undefined`.
 */
const optionalString = z
  .string()
  .nullish()
  .transform((value) => value ?? undefined)
  .optional();

export const siteInfoSchema = z.object({
  sitename: z.string(),
  username: z.string(),
  fullname: z.string().optional(),
  userid: id,
  siteurl: z.string(),
  release: z.string().optional(),
  version: z.string().optional(),
  lang: z.string().optional(),
  downloadfiles: flag.optional(),
  uploadfiles: flag.optional(),
  functions: z.array(z.object({ name: z.string(), version: z.string().optional() })),
});
export type MoodleSiteInfo = z.output<typeof siteInfoSchema>;

export const courseSchema = z.object({
  id,
  shortname: z.string(),
  fullname: z.string(),
  displayname: z.string().optional(),
  categoryid: id.optional(),
  idnumber: z.string().optional(),
  summary: z.string().optional(),
  summaryformat: z.number().int().optional(),
  format: z.string().optional(),
  visible: flag.optional(),
  startdate: timestamp.optional(),
  enddate: timestamp.optional(),
  timecreated: timestamp.optional(),
  timemodified: timestamp.optional(),
  lang: z.string().optional(),
});
export type MoodleCourse = z.output<typeof courseSchema>;
export const coursesSchema = z.array(courseSchema);

export const moduleContentSchema = z.object({
  type: z.string(),
  filename: z.string(),
  filepath: optionalString,
  filesize: z.number().int().nonnegative().optional(),
  fileurl: optionalString,
  mimetype: optionalString,
  timecreated: timestamp.nullable().optional(),
  timemodified: timestamp.nullable().optional(),
  sortorder: z.number().int().nullable().optional(),
  isexternalfile: z.boolean().optional(),
  repositorytype: optionalString,
  author: z.string().nullable().optional(),
  license: z.string().nullable().optional(),
  // Present for inline content (e.g. Book chapter index); length is bounded by the response cap.
  content: optionalString,
});
export type MoodleModuleContent = z.output<typeof moduleContentSchema>;

export const contentsInfoSchema = z.object({
  filescount: z.number().int().nonnegative(),
  filessize: z.number().int().nonnegative(),
  lastmodified: timestamp,
  mimetypes: z.array(z.string()),
  repositorytype: z.string().optional(),
});

export const courseModuleSchema = z.object({
  id,
  name: z.string(),
  modname: z.string(),
  instance: id.optional(),
  contextid: id.optional(),
  url: z.string().optional(),
  description: z.string().optional(),
  visible: flag.optional(),
  uservisible: z.boolean().optional(),
  visibleoncoursepage: flag.optional(),
  modplural: z.string().optional(),
  availabilityinfo: z.string().nullable().optional(),
  contents: z.array(moduleContentSchema).optional(),
  contentsinfo: contentsInfoSchema.optional(),
});
export type MoodleCourseModule = z.output<typeof courseModuleSchema>;

export const courseSectionSchema = z.object({
  id,
  name: z.string(),
  section: z.number().int().nonnegative().optional(),
  visible: flag.optional(),
  uservisible: z.boolean().optional(),
  summary: z.string().optional(),
  summaryformat: z.number().int().optional(),
  availabilityinfo: z.string().nullable().optional(),
  modules: z.array(courseModuleSchema),
});
export type MoodleCourseSection = z.output<typeof courseSectionSchema>;
export const courseContentsSchema = z.array(courseSectionSchema);

const roleSchema = z.object({
  roleid: id,
  name: z.string().optional(),
  shortname: z.string(),
});

export const enrolledUserSchema = z.object({
  id,
  username: z.string().optional(),
  firstname: z.string().optional(),
  lastname: z.string().optional(),
  fullname: z.string(),
  email: z.string().optional(),
  idnumber: z.string().optional(),
  suspended: z.boolean().optional(),
  roles: z.array(roleSchema).optional(),
});
export type MoodleEnrolledUser = z.output<typeof enrolledUserSchema>;
export const enrolledUsersSchema = z.array(enrolledUserSchema);

export const userCourseSchema = z.object({
  id,
  shortname: z.string(),
  fullname: z.string(),
  displayname: z.string().optional(),
  idnumber: z.string().optional(),
  visible: flag.optional(),
  format: z.string().optional(),
  category: id.optional(),
  startdate: timestamp.optional(),
  enddate: timestamp.optional(),
  lastaccess: timestamp.nullable().optional(),
  hidden: z.boolean().optional(),
  timemodified: timestamp.optional(),
});
export type MoodleUserCourse = z.output<typeof userCourseSchema>;
export const userCoursesSchema = z.array(userCourseSchema);

export const userSchema = z.object({
  id,
  username: z.string().optional(),
  firstname: z.string().optional(),
  lastname: z.string().optional(),
  fullname: z.string(),
  email: z.string().optional(),
  idnumber: z.string().optional(),
  auth: z.string().optional(),
  suspended: z.boolean().optional(),
  confirmed: z.boolean().optional(),
});
export type MoodleUser = z.output<typeof userSchema>;
export const usersSchema = z.array(userSchema);
