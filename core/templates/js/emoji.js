const emoji_layer_id = '#emoji_layer';

const first_emoji_id = '#controls';
const second_emoji_id = '#cool';
const third_emoji_id = '#bigsmile';
const fourth_emoji_id = '#sad';
const fifth_emoji_id = '#sleep';
const sixth_emoji_id = '#sick';
const seventh_emoji_id = '#poop';

const button_main_id = '#button_main';
const buttons_id = '#buttons';

const emojiLayer = document.querySelector(emoji_layer_id);

const firstEmoji = document.querySelector(first_emoji_id);
const secondEmoji = document.querySelector(second_emoji_id);
const thirdEmoji = document.querySelector(third_emoji_id);
const fourthEmoji = document.querySelector(fourth_emoji_id);
const fifthEmoji = document.querySelector(fifth_emoji_id);
const sixthEmoji = document.querySelector(sixth_emoji_id);
const seventhEmoji = document.querySelector(seventh_emoji_id);

const sendEmojiButtons = [secondEmoji, thirdEmoji, fourthEmoji, fifthEmoji, sixthEmoji, seventhEmoji];

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

// Sending collapses the stack, as in the design. The outbound message stays with each
// button's own inline handler, which runs first — this only closes the panel after it.
sendEmojiButtons.forEach(function (button) {
    if (!button) return;
    button.addEventListener('click', function () { setEmojiOpen(false); });
});

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
