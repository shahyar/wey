const fs = require('fs')
const path = require('path')
const gui = require('gui')
const opn = require('opn')
const fileUrl = require('file-url')

const ChannelHeader = require('./channel-header')

const handlebars = require('./chat/handlebars')
const accountManager = require('../controller/account-manager')
const windowManager = require('../controller/window-manager')
const {theme} = require('../controller/theme-manager')

handlebars.registerHelper('isFirstUnread', function(messageList, message, options) {
  if (messageList.firstUnreadTs === message.timestamp)
    return options.fn(this)
  else
    return options.inverse(this)
})

handlebars.registerHelper('isChannel', function(messageList, options) {
  if (messageList.type === 'channel')
    return options.fn(this)
  else
    return options.inverse(this)
})

handlebars.registerHelper('canStartThread', function(messageList, message, options) {
  if (messageList.type !== 'thread' && (!message.threadId || message.isThreadParent))
    return options.fn(this)
  else
    return options.inverse(this)
})

handlebars.registerHelper('normalizeId', function(id) {
  return 'msg' + String(id).replace('.', '_')
})

const fontStyle = fs.readFileSync(path.join(__dirname, 'chat', 'font.css')).toString()
handlebars.registerHelper('fontStyle', function() {
  return fontStyle
})

// Templates for handlebarjs.
const messageHtml = fs.readFileSync(path.join(__dirname, 'chat', 'message.html')).toString()
handlebars.registerPartial('messagePartial', messageHtml)
const messageTemplate = handlebars.compile(messageHtml)
const pageTemplate = handlebars.compile(fs.readFileSync(path.join(__dirname, 'chat', 'page.html')).toString())

// The page that shows loading indicator.
// (call realpathSync to keep compatibility with ASAR.)
const loadingUrl = fileUrl(fs.realpathSync(path.join(__dirname, 'chat', 'loading.html')))

function getMenuCallback(userId, replyEntry, deleteFrom, deleteTo) {
  return menuItem => {
    replyEntry.deleteRange(deleteFrom, deleteTo)
    replyEntry.insertText(`<@${userId}>`)
  };
}

class ChatBox {
  constructor(mainWindow) {
    this.mainWindow = mainWindow

    this.messageList = null
    this.subscription = null
    this.messagesLoaded = false
    this.isSendingReply = false
    this.isDisplaying = false
    this.pendingMessages = []

    this.view = gui.Container.create()
    this.view.setStyle({flex: 1})

    this.channelHeader = new ChannelHeader()
    // TODO Re-enable header when loading indicator is reimplemented with native
    // UI, otherwise our UI would feel unsmooth.
    this.view.addChildView(this.channelHeader.view)

    this.browser = gui.Browser.create({devtools: true, contextMenu: true})
    this.browser.setStyle({flex: 1})
    this.browser.setBindingName('wey')
    this.browser.addBinding('ready', this.ready.bind(this))
    this.browser.addBinding('openLink', this.openLink.bind(this))
    this.browser.addBinding('openLinkContextMenu', this.openLinkContextMenu.bind(this))
    this.browser.addBinding('openChannel', this.openChannel.bind(this))
    this.browser.addBinding('openThread', this.openThread.bind(this))
    this.browser.addBinding('setMessageStar', this.setMessageStar.bind(this))
    this.browser.addBinding('notifyDisplaying', this.notifyDisplaying.bind(this))
    this.browser.addBinding('notifyNotDisplaying', this.notifyNotDisplaying.bind(this))
    this.browser.addBinding('openReactionMenu', this.openReactionMenu.bind(this))
    this.browser.addBinding('toggleReaction', this.toggleReaction.bind(this))
    this.view.addChildView(this.browser)

    this.replyBox = gui.Container.create()
    this.replyBox.setBackgroundColor(theme.channelHeader.borderColor)
    this.replyBox.setStyle({padding: 5})
    this.view.addChildView(this.replyBox)

    this.replyEntry = gui.TextEdit.create()
    this.replyEntry.setEnabled(false)
    if (process.platform !== 'win32') {
      // Force using overlay scrollbar.
      this.replyEntry.setOverlayScrollbar(true)
      this.replyEntry.setScrollbarPolicy('never', 'automatic')
    }
    // Font size should be the same with messages.
    const font = gui.Font.create(gui.Font.default().getName(), 15, 'normal', 'normal')
    this.replyEntry.setFont(font)
    // Calculate height for 1 and 5 lines.
    this.replyEntry.setText('1')
    this.minReplyEntryHeight = this.replyEntry.getTextBounds().height
    this.replyEntry.setText('1\n2\n3\n4\n5')
    this.maxReplyEntryHeight = this.replyEntry.getTextBounds().height
    this.replyEntry.setText('')
    this.replyEntry.setStyle({height: this.minReplyEntryHeight})
    // Handle input events.
    this.replyEntry.onTextChange = this.adjustEntryHeight.bind(this)
    // @todo Yue bug: Use onKeyDown instead, but yue only triggers for modifier keys on MacOS at the moment
    this.replyEntry.onKeyUp = this.onKeyUp.bind(this)
    this.replyEntry.shouldInsertNewLine = this.handleEnter.bind(this)
    this.replyBox.addChildView(this.replyEntry)

    mainWindow.window.onFocus = this.notifyDisplaying.bind(this)
    mainWindow.window.onBlur = this.notifyNotDisplaying.bind(this)
  }

  unload() {
    if (this.subscription) {
      this.subscription.onMessage.detach()
      this.subscription.onDeleteMessage.detach()
      this.subscription.onModifyMessage.detach()
      this.subscription = null
    }
    if (this.messageList) {
      this.messageList.stopReceiving()
      this.messagesLoaded = false
      if (this.isDisplaying) {
        this.isDisplaying = false
        this.messageList.deselect()
      }
      this.pendingMessages = []
      this.messageList = null
    }
    this.channelHeader.unload()
  }

  setLoading() {
    if (this.browser.getURL() === loadingUrl)
      return
    this.unload()
    this.channelHeader.view.setVisible(false)
    this.replyBox.setVisible(false)
    this.browser.loadURL(loadingUrl)
  }

  async loadChannel(messageList) {
    this.unload()
    // Show progress bar if we need to fetch messages.
    if (!messageList.messagesReady) {
      this.replyEntry.setEnabled(false)
      this.setLoading()
    }
    this.messageList = messageList
    this.subscription = {
      onMessage: messageList.onMessage.add(this.newMessage.bind(this)),
      onDeleteMessage: messageList.onDeleteMessage.add(this.deleteMessage.bind(this)),
      onModifyMessage: messageList.onModifyMessage.add(this.modifyMessage.bind(this)),
    }
    // Make sure messages are loaded before loading the view.
    this.messageList.startReceiving()
    const messages = await messageList.readMessages()
    this.messagesLoaded = false
    // Start showing the messages.
    if (messageList === this.messageList) {
      this.channelHeader.loadChannel(messageList)
      this.replyBox.setVisible(true)
      // TODO Remember unsent messages.
      this.replyEntry.setText('')
      this.adjustEntryHeight()
      const html = pageTemplate({messageList, messages})
      if (process.env.WEY_DEBUG === '1')
        fs.writeFileSync('page.html', html)
      this.browser.loadHTML(html, messageList.account.url)
    }
  }

  newMessage(message) {
    if (this.threadId && this.threadId !== message.threadId)
      return
    if (!this.messagesLoaded) {
      this.pendingMessages.push(message)
      return
    }
    // Clear unread mark if the new message is the new first unread.
    let firstUnread = false
    if (message.timestamp === this.messageList.firstUnreadTs)
      firstUnread = true
    const html = messageTemplate({messageList: this.messageList, message})
    const fromCurrentUser = message.user.id === this.messageList.account.currentUserId
    this.browser.executeJavaScript(`window.addMessage(${JSON.stringify(html)}, ${firstUnread}, ${fromCurrentUser})`, () => {})
  }

  deleteMessage(id, timestamp) {
    if (this.messagesLoaded)
      this.browser.executeJavaScript(`window.deleteMessage("${id}")`, () => {})
  }

  modifyMessage(id, message) {
    if (this.messagesLoaded) {
      const html = messageTemplate({messageList: this.messageList, message})
      this.browser.executeJavaScript(`window.modifyMessage("${id}", ${JSON.stringify(html)})`, () => {})
    }
  }

  ready() {
    this.replyEntry.setEnabled(true)
    this.replyEntry.focus()
    this.messagesLoaded = true
    for (const m of this.pendingMessages)
      this.newMessage(m)
    this.pendingMessages = []
    if (this.mainWindow.window.isActive()) {
      this.isDisplaying = true
      this.messageList.select()
    }
    this.messageList.notifyRead()
  }

  openLink(link) {
    opn(link)
  }

  copyLink(link) {
    // TODO Add clipboard API in Yue.
    const linkStore = gui.TextEdit.create()
    linkStore.setText(link)
    linkStore.selectAll()
    linkStore.cut()
  }

  async toggleReaction(name, channelId, timestamp) {
    const channel = this.messageList.channel ? this.messageList.channel.id : channelId
    const message = this.messageList.findMessage(timestamp, timestamp)

    if (message && message.reactions) {
      if (message.reactions.find(reaction => reaction.name === name && reaction.hasCurrentUser)) {
        // @todo This is a hack. Don't fetch directly from RTM SDK here!
        await this.messageList.account.rtm.webClient.reactions.remove({
          name,
          channel,
          timestamp
        })
        return
      }
    }

    // @todo This is a hack. Don't fetch directly from RTM SDK here!
    await this.messageList.account.rtm.webClient.reactions.add({
      name,
      channel,
      timestamp
    })
  }

  async openReactionMenu(channel, messageId) {
    // @todo This is a hack. Don't fetch directly from RTM SDK here!
    const customEmojis = await this.messageList.account.rtm.webClient.emoji.list()
    const message = this.messageList.findMessage(messageId, messageId)

    if (message) {
      // Push existing reactions to top
      const mountedEmojis = {}
      const emojis = (message.reactions || []).map(reaction => {
        mountedEmojis[reaction.name] = true

        return {
          type: 'checkbox',
          label: reaction.name,
          checked: reaction.hasCurrentUser,
          onClick: el => this.toggleReaction(reaction.name, channel, messageId)
        }
      })

      // Show remaining emojis (but no duplicates)
      for (const name of Object.keys(customEmojis.emoji).sort()) {
        if (!mountedEmojis[name]) {
          emojis.push({
            type: 'checkbox',
            label: name,
            onClick: el => this.toggleReaction(name, channel, messageId)
          })
        }
      }

      gui.Menu.create(emojis).popup()
    }
  }

  openLinkContextMenu(link) {
    const menu = gui.Menu.create([
      { label: 'Copy Link', onClick: this.copyLink.bind(this, link)},
      { label: 'Open Link', onClick: this.openLink.bind(this, link)},
    ])
    menu.popup()
  }

  openChannel(channel) {
    this.mainWindow.channelsPanel.selectChannelById(channel)
  }

  openThread(id) {
    const win = windowManager.windows.find((w) => w.chatBox && w.chatBox.messageList.id === id)
    if (win) {
      win.window.activate()
    } else {
      const ChatWindow = require('./chat-window')
      new ChatWindow(this.messageList.openThread(id), this.view.getBounds())
    }
  }

  setMessageStar(id, timestamp, hasStar) {
    this.messageList.setMessageStar(id, timestamp, hasStar)
  }

  notifyDisplaying() {
    if (this.messagesLoaded && !this.isDisplaying) {
      this.isDisplaying = true
      this.messageList.select()
    }
  }

  notifyNotDisplaying() {
    if (this.isDisplaying) {
      this.isDisplaying = false
      this.messageList.deselect()
    }
  }

  adjustEntryHeight() {
    let height = this.replyEntry.getTextBounds().height
    if (height < this.minReplyEntryHeight)
      height = this.minReplyEntryHeight
    else if (height > this.maxReplyEntryHeight)
      height = this.maxReplyEntryHeight
    this.replyEntry.setStyle({height})
  }

  handleEnter(replyEntry) {
    if (gui.Event.isShiftPressed())
      return true
    const message = replyEntry.getText()
    if (message.trim().length == 0 || !this.messageList || this.isSendingReply)
      return false
    replyEntry.setEnabled(false)
    this.isSendingReply = true
    this.messageList
        .sendMessage(message)
        .then((res) => {
          replyEntry.setText('')
          replyEntry.setEnabled(true)
          this.adjustEntryHeight()
          this.isSendingReply = false
        })
        .catch((error) => {
          // TODO Report error
          console.error(error)
          replyEntry.setEnabled(true)
          this.isSendingReply = false
        })
    return false
  }

  onKeyUp(replyEntry, keyEvent) {
    // Only handle TAB key
    if (keyEvent.key !== 'Tab')
      return

    // Only run if no text selected
    const [pos, posB] = replyEntry.getSelectionRange()
    if (pos !== posB || pos < 1)
      return

    // Looking for @mention only
    const str = replyEntry.getTextInRange(0, pos)
    const match = str.match(/(?:^|\s+)(@[^@\r\n\t]+)\t$/)
    if (!match)
      return

    const name = match[1].substr(1)

    const { users, exactIndex } = this.messageList.account.findUsersByName(name)

    if (users.length === 1) {
      // Delete text and tab, insert user
      replyEntry.deleteRange(pos - name.length - 2, pos)
      replyEntry.insertText(`<@${users[0].id}>`)
      return true
    } else {
      // @todo Yue bug: Hack for the fact that this runs onKeyUp instead of onKeyDown, delete tab
      replyEntry.deleteRange(pos - 1, pos)
    }

    if (users.length === 0)
      return

    // Add exact match to top of results
    if (exactIndex !== null)
      users.unshift(users.splice(exactIndex, 1)[0])

    // @todo Yue feature: Make this menu appear at the caret instead of at the cursor
    const menu = gui.Menu.create(
      users.map(user => ({
        label: `@${user.name}`,
        onClick: getMenuCallback(user.id, replyEntry, pos - name.length - 2, pos - 1)
      }))
    )
    menu.popup()

    return true
  }
}

module.exports = ChatBox
