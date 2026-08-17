-- Migration: 20260817000200_provision_commercial_client_relational_rpc.sql
-- Goal: Authoritative transactional RPC for commercial client provisioning with canonical UNIQUE constraints.

-- 1. Create canonical UNIQUE indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_commercial_clients_lower_email 
ON public.commercial_clients (LOWER(TRIM(email)));

CREATE UNIQUE INDEX IF NOT EXISTS idx_commercial_clients_digits_document 
ON public.commercial_clients ((regexp_replace(document, '\D', '', 'g'))) 
WHERE document IS NOT NULL AND regexp_replace(document, '\D', '', 'g') != '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_commercial_clients_client_code 
ON public.commercial_clients (client_code);

CREATE UNIQUE INDEX IF NOT EXISTS idx_client_users_client_user 
ON public.client_users (client_id, user_id);

-- 2. Drop existing RPC if overloaded
DROP FUNCTION IF EXISTS public.provision_commercial_client_relational(uuid, uuid, text, text, text, text, text, text, text, text, text, text, numeric, numeric, text, text, text, text, text, text, text, text);

-- 3. Create transactional RPC
CREATE OR REPLACE FUNCTION public.provision_commercial_client_relational(
    p_actor_user_id UUID,
    p_auth_user_id UUID,
    p_establishment_name TEXT,
    p_responsible_name TEXT,
    p_phone TEXT,
    p_email TEXT,
    p_document TEXT DEFAULT NULL,
    p_address TEXT DEFAULT NULL,
    p_complement TEXT DEFAULT NULL,
    p_neighborhood TEXT DEFAULT NULL,
    p_city TEXT DEFAULT NULL,
    p_postal_code TEXT DEFAULT NULL,
    p_pickup_latitude NUMERIC DEFAULT NULL,
    p_pickup_longitude NUMERIC DEFAULT NULL,
    p_pickup_place_id TEXT DEFAULT NULL,
    p_street_number TEXT DEFAULT NULL,
    p_route TEXT DEFAULT NULL,
    p_state TEXT DEFAULT NULL,
    p_map_color TEXT DEFAULT '#ffb700',
    p_notes TEXT DEFAULT NULL,
    p_lifecycle_status TEXT DEFAULT 'ativo',
    p_financial_status TEXT DEFAULT 'em_dia'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_actor_role TEXT;
    v_actor_active BOOLEAN;
    v_email_norm TEXT;
    v_phone_norm TEXT;
    v_doc_norm TEXT;
    v_client_code TEXT;
    v_client_rec RECORD;
    v_next_seq BIGINT;
BEGIN
    -- 1. Validate Actor Authority
    SELECT role, COALESCE(is_active, true)
    INTO v_actor_role, v_actor_active
    FROM public.user_profiles
    WHERE user_id = p_actor_user_id;

    IF NOT FOUND OR v_actor_active IS NOT TRUE OR v_actor_role NOT IN ('owner', 'admin', 'operador', 'gerente') THEN
        RAISE EXCEPTION 'Acesso negado: ator % nao possui permissao administrativa ativa.', p_actor_user_id
            USING ERRCODE = '42501';
    END IF;

    -- 2. Normalize canonical inputs
    v_email_norm := LOWER(TRIM(p_email));
    v_phone_norm := regexp_replace(p_phone, '\D', '', 'g');
    v_doc_norm := CASE 
        WHEN p_document IS NOT NULL AND TRIM(p_document) != '' THEN regexp_replace(p_document, '\D', '', 'g')
        ELSE NULL 
    END;

    -- 3. Insert user_profiles
    INSERT INTO public.user_profiles (user_id, name, email, role, is_active)
    VALUES (p_auth_user_id, p_responsible_name, v_email_norm, 'client_user', true);

    -- 4. Generate next client_code from sequence
    v_next_seq := nextval('public.commercial_client_code_seq');
    v_client_code := 'CLI-' || lpad(v_next_seq::text, 6, '0');

    -- 5. Insert commercial_clients
    INSERT INTO public.commercial_clients (
        client_code, establishment_name, responsible_name, phone, email, document,
        address, neighborhood, city, postal_code,
        pickup_latitude, pickup_longitude, pickup_place_id, street_number, route, state,
        lifecycle_status, financial_status
    ) VALUES (
        v_client_code, p_establishment_name, p_responsible_name, v_phone_norm, v_email_norm, COALESCE(v_doc_norm, v_email_norm),
        p_address, p_neighborhood, p_city, p_postal_code,
        p_pickup_latitude, p_pickup_longitude, p_pickup_place_id, p_street_number, p_route, p_state,
        COALESCE(p_lifecycle_status, 'ativo'), COALESCE(p_financial_status, 'em_dia')
    )
    RETURNING * INTO v_client_rec;

    -- 6. Insert client_users
    INSERT INTO public.client_users (client_id, user_id, role, status)
    VALUES (v_client_rec.id, p_auth_user_id, 'admin', 'ativo');

    -- 7. Insert system_audit_logs with target_resource
    INSERT INTO public.system_audit_logs (actor_type, actor_id, action, target_resource, details)
    VALUES (
        v_actor_role,
        p_actor_user_id::text,
        'commercial_client_created',
        'commercial_client',
        jsonb_build_object(
            'client_id', v_client_rec.id,
            'client_code', v_client_rec.client_code,
            'establishment_name', v_client_rec.establishment_name,
            'email', v_client_rec.email
        )
    );

    RETURN to_jsonb(v_client_rec);
END;
$$;

-- 4. Set minimal privilege
REVOKE ALL ON FUNCTION public.provision_commercial_client_relational FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provision_commercial_client_relational TO service_role;
