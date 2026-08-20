import { z } from "zod";

export const createUserSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
  // Long enough to be worth the bcrypt cost. Admins hand these out; users are
  // expected to change them.
  password: z.string().min(10, "Password must be at least 10 characters."),
  role: z.enum(["admin", "user"]).default("user"),
  credits: z.number().int().min(0).max(100_000).default(0),
});

export const updateUserSchema = z
  .object({
    credits: z.number().int().min(0).max(100_000).optional(),
    role: z.enum(["admin", "user"]).optional(),
    password: z.string().min(10, "Password must be at least 10 characters.").optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update." });

/**
 * The shape the model is asked to return.
 *
 * Column names come from the sheet itself rather than a fixed list, because the
 * user asked for every column a registration sheet carries — which varies from
 * document to document. `values` aligns positionally with `columns`; the route
 * re-checks that alignment rather than trusting it, since a schema can require
 * an array without requiring it to be the right length.
 */
export const extractionSchema = z.object({
  /**
   * The printed event name and/or date, used to name the workbook for a photo
   * upload — photos have no useful file name of their own. Optional because a
   * sheet may print neither, in which case the caller falls back to the date.
   */
  title: z.string().optional(),
  columns: z.array(z.string()).min(1),
  rows: z.array(
    z.object({
      page: z.number().int().min(1),
      values: z.array(z.string()),
    }),
  ),
});

export type Extraction = z.infer<typeof extractionSchema>;
