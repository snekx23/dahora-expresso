-- =====================================================================
-- Dahora Expresso — Migration: Localização Autoritativa do Cliente Comercial
-- Timestamp: 20260811000100
-- Descrição: Adiciona colunas para geolocalização autoritativa de coleta em public.commercial_clients
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'commercial_clients' AND column_name = 'pickup_latitude'
  ) THEN
    ALTER TABLE public.commercial_clients ADD COLUMN pickup_latitude DOUBLE PRECISION;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'commercial_clients' AND column_name = 'pickup_longitude'
  ) THEN
    ALTER TABLE public.commercial_clients ADD COLUMN pickup_longitude DOUBLE PRECISION;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'commercial_clients' AND column_name = 'pickup_place_id'
  ) THEN
    ALTER TABLE public.commercial_clients ADD COLUMN pickup_place_id TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'commercial_clients' AND column_name = 'street_number'
  ) THEN
    ALTER TABLE public.commercial_clients ADD COLUMN street_number TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'commercial_clients' AND column_name = 'route'
  ) THEN
    ALTER TABLE public.commercial_clients ADD COLUMN route TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'commercial_clients' AND column_name = 'state'
  ) THEN
    ALTER TABLE public.commercial_clients ADD COLUMN state TEXT;
  END IF;
END $$;
