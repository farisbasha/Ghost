import { expect } from 'vitest';
import { page, userEvent, type Locator } from 'vitest/browser';
import {
  fakeAutomatedEmails,
  fakeNewsletters,
  fakeOffers,
  fakePosts,
} from '@test-utils/acceptance';

// Endpoints the email editor fetches on open.
export const fakeEmailEditorData = () => {
  fakeAutomatedEmails([]);
  fakeNewsletters([]);
  fakeOffers([]);
  fakePosts([]);
};

export const emailEditor = () => page.getByRole('dialog', { name: 'Edit email', exact: true });
export const emailEditorBody = () => emailEditor().getByTestId('email-editor').getByRole('textbox');

export const minimizeEmailEditor = async () => {
  await emailEditor().getByRole('button', { name: 'Minimize editor' }).click();
  await expect(emailEditor()).toHaveCount(0);
};

// The subject is edited in the email editor, opened from the card's message preview. The card
// can start below the canvas's visible area, and React Flow undoes the scroll that would bring
// it into view, so a click can land where the card was before the scroll. Enter on the focused
// button opens the editor wherever the card is.
export const editEmailSubject = async (card: Locator, subject: string) => {
  const editContent = card.getByRole('button', { name: 'Edit email content' });
  await expect.element(editContent).toBeInTheDocument();
  editContent.element().focus();
  await userEvent.keyboard('{Enter}');
  await emailEditor().getByRole('textbox', { name: 'Subject line' }).fill(subject);
  await minimizeEmailEditor();
};
