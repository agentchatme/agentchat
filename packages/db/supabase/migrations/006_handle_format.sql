-- Tighten handle format: letters, digits, and single hyphens only.
-- Must start with a letter. Must end with a letter or digit.
-- No consecutive hyphens. No underscores. No leading digits.

-- Step 1: Drop the old CHECK constraint
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_handle_check;

-- Step 2: Add the new CHECK constraint
-- Pattern: starts with [a-z], then groups of ([a-z0-9]+ followed by -), ending with [a-z0-9]+
-- This naturally prevents: leading digits, trailing hyphens, consecutive hyphens, underscores
ALTER TABLE agents ADD CONSTRAINT agents_handle_check CHECK (
  handle ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
  AND length(handle) >= 3
  AND length(handle) <= 30
);
