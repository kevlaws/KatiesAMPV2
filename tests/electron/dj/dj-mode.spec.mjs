import { expect, login, navigateTo, test } from '../fixtures/katiesamp-test.mjs';

const administratorPassword = 'administrator-password';
const djPassword = 'separate-dj-password';

test.use({ serverLock: 'false' });

test('@full configures and opens the separate password-protected DJ workspace', async ({
    mockJellyfin,
    page,
}) => {
    mockJellyfin.setMusicFolders([
        { id: 'music-folder-1', name: "Katie O'Brien's Music" },
        { id: 'music-folder-2', name: 'DJ Music' },
    ]);
    await login(page);

    const mainFolder = page.getByRole('combobox', { name: 'Select music folder' });
    await mainFolder.click();
    await page.getByRole('option', { name: "Katie O'Brien's Music" }).click();

    await navigateTo(page, '/settings');
    await page
        .getByRole('textbox', { exact: true, name: 'Administrator password' })
        .fill(administratorPassword);
    await page.getByLabel('Confirm administrator password').fill(administratorPassword);
    await page.getByRole('button', { name: 'Set password and continue' }).click();

    await page.getByRole('button', { exact: true, name: 'Set DJ password' }).click();
    await page.getByRole('textbox', { exact: true, name: 'New DJ password' }).fill(djPassword);
    await page.getByRole('textbox', { name: 'Confirm new DJ password' }).fill(djPassword);
    await page
        .getByRole('dialog')
        .getByRole('button', { exact: true, name: 'Set DJ password' })
        .click();
    await expect(page.getByText('DJ password saved.')).toBeVisible();
    await expect(page.getByLabel('Enable DJ Mode')).toBeChecked();

    await navigateTo(page, '/');
    await page.getByRole('button', { exact: true, name: 'DJ Mode' }).click();
    await page
        .getByRole('textbox', { exact: true, name: 'DJ password' })
        .fill(administratorPassword);
    await page.getByRole('button', { exact: true, name: 'Open DJ Mode' }).click();
    await expect(page.getByText('The DJ password is incorrect.')).toBeVisible();
    await page.getByRole('textbox', { exact: true, name: 'DJ password' }).fill(djPassword);
    await page.getByRole('button', { exact: true, name: 'Open DJ Mode' }).click();

    const workspace = page.getByRole('dialog', { name: 'KatiesAmp DJ Mode' });
    await expect(workspace).toBeVisible();
    await expect(page.locator('#player-bar')).toHaveCount(0);
    await expect(workspace.getByRole('heading', { name: 'DJ Mode' })).toBeVisible();
    const djFolder = workspace.getByRole('combobox', { name: 'Select DJ music folder' });
    await expect(djFolder).toHaveValue("Katie O'Brien's Music");
    await expect(workspace.getByText('Automation Track 1', { exact: true })).toBeVisible();
    const deckA = workspace.getByRole('region', { name: 'Deck A' });
    const deckAControls = workspace.getByRole('complementary', { name: 'Deck A controls' });
    const masterMixer = workspace.getByRole('region', { name: 'Master mixer' });
    const deckBControls = workspace.getByRole('complementary', { name: 'Deck B controls' });
    const deckB = workspace.getByRole('region', { name: 'Deck B' });
    await expect(deckA).toContainText('Not ready');
    await expect(deckAControls).toContainText('A');
    await expect(deckBControls).toContainText('B');
    const deckABox = await deckA.boundingBox();
    const deckAControlsBox = await deckAControls.boundingBox();
    const masterMixerBox = await masterMixer.boundingBox();
    const deckBControlsBox = await deckBControls.boundingBox();
    const deckBBox = await deckB.boundingBox();
    expect(deckABox).not.toBeNull();
    expect(deckAControlsBox).not.toBeNull();
    expect(masterMixerBox).not.toBeNull();
    expect(deckBControlsBox).not.toBeNull();
    expect(deckBBox).not.toBeNull();
    expect(deckABox.x).toBeLessThan(deckAControlsBox.x);
    expect(deckAControlsBox.x).toBeLessThan(masterMixerBox.x);
    expect(masterMixerBox.x).toBeLessThan(deckBControlsBox.x);
    expect(deckBControlsBox.x).toBeLessThan(deckBBox.x);
    const positionBox = await deckA.getByLabel('Deck A position').boundingBox();
    const waveformBox = await deckA.getByLabel('Deck A waveform').boundingBox();
    expect(positionBox).not.toBeNull();
    expect(waveformBox).not.toBeNull();
    expect(positionBox.y).toBeLessThan(waveformBox.y);
    expect(waveformBox.height).toBeLessThanOrEqual(80);

    await workspace
        .getByRole('button', { name: 'Load Automation Track 1 to Deck A' })
        .first()
        .click();
    await expect(deckA).toContainText('Automation Track 1');
    const treble = deckAControls.getByLabel('Deck A Treble');
    await treble.fill('6');
    await expect(treble).toHaveValue('6');
    await treble.dblclick();
    await expect(treble).toHaveValue('0');
    await deckA.getByRole('button', { name: 'Eject Deck A' }).click();
    await expect(deckA).not.toContainText('Automation Track 1');
    await expect(deckA).toContainText('Not ready');

    await workspace.getByRole('button', { name: 'Add Automation Track 2 to preparation' }).click();
    await expect(workspace.getByText('Automation Track 2', { exact: true })).toHaveCount(2);

    await djFolder.click();
    await page.getByRole('option', { name: 'DJ Music' }).click();
    await expect(djFolder).toHaveValue('DJ Music');
    await workspace.getByLabel('Crossfader').fill('1');
    await workspace.getByRole('button', { exact: true, name: 'Exit DJ Mode' }).click();
    await expect(workspace).not.toBeVisible();
    await expect(page.locator('#player-bar')).toBeVisible();
    await expect(mainFolder).toHaveValue("Katie O'Brien's Music");
});
