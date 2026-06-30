DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'field_color_scales' AND column_name = 'created_at'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'field_color_scales' AND column_name = 'createdAt'
  ) THEN
    ALTER TABLE "field_color_scales" RENAME COLUMN "created_at" TO "createdAt";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'field_color_scales' AND column_name = 'activated_at'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'field_color_scales' AND column_name = 'activatedAt'
  ) THEN
    ALTER TABLE "field_color_scales" RENAME COLUMN "activated_at" TO "activatedAt";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'result_field_extents' AND column_name = 'created_at'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'result_field_extents' AND column_name = 'createdAt'
  ) THEN
    ALTER TABLE "result_field_extents" RENAME COLUMN "created_at" TO "createdAt";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'result_field_extents' AND column_name = 'updated_at'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'result_field_extents' AND column_name = 'updatedAt'
  ) THEN
    ALTER TABLE "result_field_extents" RENAME COLUMN "updated_at" TO "updatedAt";
  END IF;
END $$;
