-- CSD_SSPET500, CSD_SSPET400 and the combined "CSD_SSPET500/400" are one pack,
-- CSD_SSPET400. Uploads read the other names as CSD_SSPET400 (see PACK_ALIASES);
-- here CSD_SSPET400 is made sure to exist (when one of the others does) and the
-- others leave the active packs. Months already open keep their own pack snapshot.
INSERT INTO packs (code, grp, active, sort, sub)
SELECT 'CSD_SSPET400', 'CSD', 1,
       COALESCE((SELECT MIN(sort) FROM packs WHERE upper(replace(replace(code, '_', ''), ' ', '')) IN ('CSDSSPET500', 'CSDSSPET500/400', 'CSDSSPET400/500')), 0), 'SSNR'
WHERE NOT EXISTS (SELECT 1 FROM packs WHERE upper(replace(replace(code, '_', ''), ' ', '')) = 'CSDSSPET400')
  AND EXISTS (SELECT 1 FROM packs WHERE upper(replace(replace(code, '_', ''), ' ', '')) IN ('CSDSSPET500', 'CSDSSPET500/400', 'CSDSSPET400/500'));

UPDATE packs SET active = 1
WHERE upper(replace(replace(code, '_', ''), ' ', '')) = 'CSDSSPET400';

UPDATE packs SET active = 0
WHERE upper(replace(replace(code, '_', ''), ' ', '')) IN ('CSDSSPET500', 'CSDSSPET500/400', 'CSDSSPET400/500');

-- Route sales and previous route targets already stored: add the other names into CSD_SSPET400.
UPDATE data_routes
SET values_json = json_remove(
  json_set(values_json, '$.CSD_SSPET400',
    COALESCE(json_extract(values_json, '$.CSD_SSPET400'), 0) + COALESCE(json_extract(values_json, '$."CSD_SSPET500"'), 0)),
  '$."CSD_SSPET500"')
WHERE json_type(values_json, '$."CSD_SSPET500"') IN ('integer', 'real');

UPDATE data_routes
SET values_json = json_remove(
  json_set(values_json, '$.CSD_SSPET400',
    COALESCE(json_extract(values_json, '$.CSD_SSPET400'), 0) + COALESCE(json_extract(values_json, '$."CSD_SSPET500/400"'), 0)),
  '$."CSD_SSPET500/400"')
WHERE json_type(values_json, '$."CSD_SSPET500/400"') IN ('integer', 'real');

UPDATE data_routes
SET values_json = json_remove(
  json_set(values_json, '$.CSD_SSPET400',
    COALESCE(json_extract(values_json, '$.CSD_SSPET400'), 0) + COALESCE(json_extract(values_json, '$."CSD_SSPET400/500"'), 0)),
  '$."CSD_SSPET400/500"')
WHERE json_type(values_json, '$."CSD_SSPET400/500"') IN ('integer', 'real');
