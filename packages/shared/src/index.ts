import { z } from "zod";

export const TrustTierSchema = z.enum([
  "T0",
  "T1",
  "T2",
  "T3",
]);

export const FDRSchema = z
  .object({
    id: z.string().trim().min(1, "FDR ID is required"),
    institution: z.string().trim().min(1, "Institution is required"),
    amount: z.number().positive("Amount must be positive"),
    issueDate: z.string().date(),
    maturityDate: z.string().date(),
    trustTier: TrustTierSchema,
  })
  .refine(
    (fdr) => fdr.maturityDate >= fdr.issueDate,
    {
      message: "Maturity date cannot be earlier than issue date",
      path: ["maturityDate"],
    },
  );

export type TrustTier = z.infer<typeof TrustTierSchema>;
export type FDR = z.infer<typeof FDRSchema>;