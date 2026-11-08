// Configuration Supabase (valeurs PUBLIQUES par conception : la cle "anon" est faite pour etre dans l'appli ;
// la securite est assuree par les regles RLS cote Supabase, voir supabase.sql).
// Tant que les deux valeurs sont vides, l'appli fonctionne en mode local (donnees dans le telephone uniquement).
window.RECETTES_CONFIG = {
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: ''
};
