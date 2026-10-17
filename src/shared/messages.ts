// Message protocol between the side panel and content scripts.
// Panel -> content: chrome.tabs.sendMessage(tabId, msg, { frameId }).
// Content -> panel: chrome.runtime.sendMessage(FieldsUpdated); the panel reads sender.frameId.

import type { DetectedField, PageInfo } from './schema';

export interface ScanRequest {
  type: 'scan';
}

export interface FillRequest {
  type: 'fill';
  id: string;
  /** Text, or the option label for select/radio/combobox. Checkbox: "Yes"/"No". */
  value: string;
  /** Option labels for multi-selects and checkbox groups. */
  values?: string[];
  pageUrl?: string;
  question?: string;
  onlyIfEmpty?: boolean;
}

export interface FocusRequest {
  type: 'focus';
  id: string;
}

export interface JobDescriptionRequest {
  type: 'jobDescription';
}

export type ToContent = ScanRequest | FillRequest | FocusRequest | JobDescriptionRequest;

export interface FieldsUpdated {
  type: 'fieldsUpdated';
  page: PageInfo;
  fields: DetectedField[];
}

export type FillStatus = 'ok' | 'notFound' | 'optionMissing' | 'tooLong' | 'failed' | 'refused';

export interface FillResult {
  status: FillStatus;
  detail?: string;
}
