// Dahora Expresso — Configurações do Supabase
// Para separar os bancos de dados, altere os valores abaixo para as credenciais do seu novo projeto Supabase.
const SUPABASE_CONFIG = {
  url: 'https://fajkqyapnycnnumpdwrr.supabase.co',
  key: 'sb_publishable_zkb7DUOrpx9fiF6Af0cH8A_V8LrSb1a'
};

if (typeof window !== 'undefined') {
  window.SUPABASE_CONFIG = SUPABASE_CONFIG;
}
