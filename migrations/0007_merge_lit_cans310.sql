-- LIT_CANS310 and LIT_CANS320 are one pack, LIT_CANS310 (the department
-- target file already gives them as "LIT_CANS310+320"). Uploads read
-- LIT_CANS320 and LIT_CANS310+320 as LIT_CANS310 (see PACK_ALIASES); here
-- LIT_CANS310 is made sure to exist and LIT_CANS320 leaves the active packs.
-- Months already open keep their own pack snapshot.
INSERT INTO packs (code, grp, active, sort, sub)
SELECT 'LIT_CANS310', 'LRB-Others', 1,
       COALESCE((SELECT sort FROM packs WHERE upper(replace(code, '_', '')) = 'LITCANS320'), 0), 'LIT'
WHERE NOT EXISTS (SELECT 1 FROM packs WHERE upper(replace(replace(code, '_', ''), ' ', '')) = 'LITCANS310');

UPDATE packs SET active = 1, sub = COALESCE(sub, 'LIT')
WHERE upper(replace(replace(code, '_', ''), ' ', '')) = 'LITCANS310';

UPDATE packs SET active = 0
WHERE upper(replace(replace(code, '_', ''), ' ', '')) = 'LITCANS320';

-- Route sales and previous route targets already stored: add LIT_CANS320 into LIT_CANS310.
UPDATE data_routes
SET values_json = json_remove(
  json_set(values_json, '$.LIT_CANS310',
    COALESCE(json_extract(values_json, '$.LIT_CANS310'), 0) + COALESCE(json_extract(values_json, '$.LIT_CANS320'), 0)),
  '$.LIT_CANS320')
WHERE json_type(values_json, '$.LIT_CANS320') IN ('integer', 'real');
