import { z } from "zod";

export const ProjectEntrySchema = z.object({
  repo: z.string().url(),
  branch: z.string().default("main"),
  profile: z.string().default(".pi/pipeline.yaml"),
  language: z.string(),
  description: z.string().optional(),
});

export const ProjectRegistrySchema = z
  .object({
    default: z.string(),
    projects: z.record(z.string(), ProjectEntrySchema),
  })
  .refine((data) => data.default in data.projects, {
    message: "default project must exist in projects map",
  });

export type ProjectEntry = z.infer<typeof ProjectEntrySchema>;
export type ProjectRegistry = z.infer<typeof ProjectRegistrySchema>;
