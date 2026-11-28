-- The CD shifting cases between departments after the target went to the Heads:
-- set while the shift is open ({"at": "...", "from": {deptId: {pack: cases}}}), cleared when Admin re-sends.
ALTER TABLE cycles ADD COLUMN shift_json TEXT;
