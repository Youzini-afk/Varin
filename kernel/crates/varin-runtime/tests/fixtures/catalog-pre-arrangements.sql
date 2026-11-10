-- Remove post-89 reference metadata as well; this fixture represents a released
-- pre-89 Catalog, not a current database with only its version label changed.
DROP TABLE model_reference_holders;
DROP TABLE model_references;
DROP TABLE model_reference_space;
DROP TABLE model_execution_aliases;
DROP TABLE model_executions;
DROP TABLE model_agents;
DROP TABLE model_bound_targets;
ALTER TABLE external_items DROP COLUMN kind;
ALTER TABLE external_items DROP COLUMN tool_status;
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
