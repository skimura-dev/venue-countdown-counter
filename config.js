// Supabase 無料枠のプロジェクトURLと publishable/anon public key を入れると、
// 別Wi-Fi/4G/5Gのスマホから回答を集計できます。
// 空欄のままなら、このブラウザ内だけで動くローカル確認モードです。
window.SUPABASE_URL = "https://xxftmypgnskthhfaxtcx.supabase.co";
window.SUPABASE_ANON_KEY = "sb_publishable_iP53z6SV2Y2bMIEI1ArNTQ_pTKr1-9T";

// Supabase設定がある場合はSupabaseを優先します。
// Supabase切替前にデプロイしても現行運用を壊さないため、旧Google Apps Script版URLは残しています。
window.EVENT_API_URL = "https://script.google.com/macros/s/AKfycbzVgbuxhQZd0gUhu6HGoG2NwqmmAWQXIbaVTtEii8tNAFSDuolWHm6qB1-tykk2phf0aQ/exec";
