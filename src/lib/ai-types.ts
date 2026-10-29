/**
 * Contratto tra /api/ai/chat e il componente MaylanaAIChat.
 * Le "card" sono costruite dal server con dati del database: il browser non
 * mostra mai servizi, prezzi o orari scritti dal modello.
 */
export type AiServiceCard = {
  id: string;
  name: string;
  group: string;
  description: string | null;
  durationMinutes: number | null;
  priceCents: number | null;
  priceFrom: boolean;
  bookable: 'online' | 'request';
};

export type AiTime = { startsAt: string; endsAt: string; recommended: boolean; staff: { id: string; name: string }[] };

export type AiCard =
  | { type: 'services'; services: AiServiceCard[] }
  | {
      type: 'slots';
      serviceIds: string[];
      label: string;
      date: string;
      durationMinutes: number;
      priceCents: number | null;
      priceIsEstimate: boolean;
      staffId: string | null;
      times: AiTime[];
      partOfDay: 'mattina' | 'pomeriggio' | 'qualsiasi';
    }
  | {
      type: 'booking';
      serviceIds: string[];
      label: string;
      staffId: string | null;
      staffName: string | null;
      startsAt: string;
      endsAt: string;
      durationMinutes: number;
      priceCents: number | null;
      priceIsEstimate: boolean;
    }
  | {
      type: 'request';
      serviceIds: string[];
      label: string;
      isConsultation: boolean;
      preferredDate: string | null;
      timeWindow: 'mattina' | 'pomeriggio' | 'indifferente';
      dates: string[];
    }
  | { type: 'contact' }
  | { type: 'open_form'; serviceIds: string[]; label: string };

/** Azioni deterministiche inviate dai pulsanti della chat (nessuna chiamata al modello). */
export type AiAction =
  | { type: 'prices' }
  | { type: 'contact' }
  | { type: 'services'; group: string | null }
  | { type: 'availability'; serviceIds: string[]; date: string; staffId: string | null }
  | { type: 'select_slot'; serviceIds: string[]; startsAt: string; staffId: string | null }
  | { type: 'consultation'; serviceId: string | null };

export type AiHistoryItem = { role: 'user' | 'assistant'; text: string; sig: string };

export type AiChatResponse = {
  sessionToken: string;
  /** Messaggio del cliente come registrato (con eventuali dati omessi) e sua firma. */
  user: AiHistoryItem | null;
  reply: AiHistoryItem;
  cards: AiCard[];
  quickReplies: string[];
  source: 'faq' | 'local' | 'model';
  turnsLeft: number;
};

export type AiPublicStatus = {
  available: boolean;
  welcome: string | null;
  maxInputChars: number;
};
