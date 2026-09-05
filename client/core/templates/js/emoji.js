const emoji_layer_id = '#emoji_layer';

const first_emoji_id = '#controls';

const button_main_id = '#button_main';
const buttons_id = '#buttons';

const emojiLayer = document.querySelector(emoji_layer_id);

const firstEmoji = document.querySelector(first_emoji_id);

const buttons = document.querySelector(buttons_id);
const buttonMain = document.querySelector(button_main_id);

let isEmojiOpen = false;
let isMainButtonClick = false;

// One state class on the layer, instead of six per-button classes: the stack is either
// open or it is not, and CSS decides everything that follows from that.
function setEmojiOpen(open) {
    isEmojiOpen = !!open;

    if (emojiLayer) emojiLayer.classList.toggle('emoji-open', isEmojiOpen);
    if (firstEmoji) firstEmoji.setAttribute('aria-expanded', isEmojiOpen ? 'true' : 'false');
}

function onFirstEmojiClick() {
    setEmojiOpen(!isEmojiOpen);
}

if (firstEmoji) firstEmoji.addEventListener('click', onFirstEmojiClick);

// The stack used to collapse after every sent emoji; now it stays open so the
// player can send as many as they want, and closes manually via the toggle (#controls)
// or automatically on the next screen change (HideAll → pqCloseEmojiStack below).
// The outbound message stays with each button's own inline handler.
setEmojiOpen(false);

// main.js collapses the stack from HideAll(), so a screen change never leaves it open.
window.pqCloseEmojiStack = function () { setEmojiOpen(false); };

function onMainButtonClick() {
    isMainButtonClick = !isMainButtonClick;

    if (isMainButtonClick) {
        buttons.classList.add('buttons-visible');
        buttons.classList.remove('buttons-hidden');
    } else {
        buttons.classList.remove('buttons-visible');
        buttons.classList.add('buttons-hidden');
    }
}

if (buttonMain) buttonMain.addEventListener('click', onMainButtonClick);

// main.js collapses the camera stack when the host loses camera control mid-session.
window.pqCloseCameraStack = function () {
    isMainButtonClick = false;

    if (!buttons) return;

    buttons.classList.remove('buttons-visible');
    buttons.classList.add('buttons-hidden');
};
