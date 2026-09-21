-- Counters behind public identifiers (XN-10082, XN-WL-1842, XN-TK-0452).
--
-- Dedicated sequences rather than `max(id) + 1` or a counter row: nextval is
-- atomic and lock-free under concurrency, and never hands the same number to
-- two transactions. A rolled-back transaction burns its number, so gaps are
-- expected and harmless -- uniqueness is the property that matters here, not
-- contiguity.
--
-- Users start at 10000 so the first account reads as XN-10082 rather than
-- XN-00001, which would advertise exactly how small the community is.

CREATE SEQUENCE IF NOT EXISTS public_id_user_seq        AS BIGINT START WITH 10000 INCREMENT BY 1 MINVALUE 1 NO MAXVALUE CACHE 1;
CREATE SEQUENCE IF NOT EXISTS public_id_application_seq AS BIGINT START WITH 1000  INCREMENT BY 1 MINVALUE 1 NO MAXVALUE CACHE 1;
CREATE SEQUENCE IF NOT EXISTS public_id_character_seq   AS BIGINT START WITH 1000  INCREMENT BY 1 MINVALUE 1 NO MAXVALUE CACHE 1;
CREATE SEQUENCE IF NOT EXISTS public_id_ticket_seq      AS BIGINT START WITH 100   INCREMENT BY 1 MINVALUE 1 NO MAXVALUE CACHE 1;
CREATE SEQUENCE IF NOT EXISTS public_id_interview_seq   AS BIGINT START WITH 100   INCREMENT BY 1 MINVALUE 1 NO MAXVALUE CACHE 1;
CREATE SEQUENCE IF NOT EXISTS public_id_report_seq      AS BIGINT START WITH 100   INCREMENT BY 1 MINVALUE 1 NO MAXVALUE CACHE 1;
CREATE SEQUENCE IF NOT EXISTS public_id_appeal_seq      AS BIGINT START WITH 100   INCREMENT BY 1 MINVALUE 1 NO MAXVALUE CACHE 1;
