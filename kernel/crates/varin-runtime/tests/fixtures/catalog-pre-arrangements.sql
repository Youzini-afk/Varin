-- Remove the arrangement domain before reconstructing a pre-89 Catalog fixture.
-- The caller separately restores older domains and writes the historical format marker.
DROP TABLE followup_event_file_refs;
DROP TABLE followup_event_routes;
DROP TABLE followup_event_matches;
DROP TABLE followup_event_consumers;
DROP TABLE followup_event_imports;
DROP TABLE followup_events;
DROP TABLE followup_event_sources;
DROP INDEX followups_bot;
UPDATE followups SET body=json_remove(body,
    '$.owner','$.name','$.timing','$.event_after','$.calendar_after','$.principal_id',
    '$.external_conversation_id','$.discard_before_ms','$.first_contact');
UPDATE followup_occurrences SET body=json_remove(body,
    '$.passive','$.cancelled','$.target','$.user_input','$.external_delivery');
UPDATE input_queue SET body=json_remove(body,'$.origin.user_input') WHERE origin='followup';
