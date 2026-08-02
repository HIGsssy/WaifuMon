ALTER TABLE "species" ADD COLUMN "affinity" text DEFAULT 'switch' NOT NULL;--> statement-breakpoint
ALTER TABLE "species" ADD CONSTRAINT "species_affinity_check" CHECK ("species"."affinity" in ('dominant','submissive','caregiver','primal','switch'));
