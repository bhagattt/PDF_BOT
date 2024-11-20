require('dotenv').config();
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const sizeOf = require('image-size');
const { PDFDocument: PDFLib } = require('pdf-lib');

// Create necessary directories
const uploadDir = path.join(__dirname, 'uploads');
const tempDir = path.join(__dirname, 'temp');
[uploadDir, tempDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir);
    }
});

// User state management
class UserStateManager {
    constructor() {
        this.states = new Map();
        this.pdfs = new Map();
        this.timeouts = new Map();
        this.timeout = 5 * 60 * 1000; // 5 minutes timeout
    }

    setState(userId, state, data = null) {
        this.states.set(userId, {
            state,
            data,
            timestamp: Date.now()
        });
        
        // Clear existing timeout if any
        if (this.timeouts.has(userId)) {
            clearTimeout(this.timeouts.get(userId));
        }
        
        // Set new timeout
        const timeoutId = setTimeout(() => {
            if (this.states.has(userId)) {
                this.clearState(userId);
            }
        }, this.timeout);
        
        this.timeouts.set(userId, timeoutId);
    }

    getState(userId) {
        const state = this.states.get(userId);
        if (state && Date.now() - state.timestamp > this.timeout) {
            this.clearState(userId);
            return null;
        }
        return state;
    }

    clearState(userId) {
        this.states.delete(userId);
        this.pdfs.delete(userId);
        if (this.timeouts.has(userId)) {
            clearTimeout(this.timeouts.get(userId));
            this.timeouts.delete(userId);
        }
    }

    addPDF(userId, pdf) {
        if (!this.pdfs.has(userId)) {
            this.pdfs.set(userId, []);
        }
        this.pdfs.get(userId).push(pdf);
    }

    getPDFs(userId) {
        return this.pdfs.get(userId) || [];
    }
}

// Initialize WhatsApp client
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox']
    }
});

const userStateManager = new UserStateManager();

const STATES = {
    IDLE: 'IDLE',
    AWAITING_IMAGE: 'AWAITING_IMAGE',
    AWAITING_PDF_MERGE: 'AWAITING_PDF_MERGE',
    AWAITING_PDF_COMPRESS: 'AWAITING_PDF_COMPRESS'
};

const commands = {
    'main': {
        '1': '📸 Convert Image to PDF',
        '2': '🔄 Merge PDFs',
        '3': '🗜️ Compress PDF',
        '4': 'ℹ️ About PDF Bot',
        '5': '❌ Cancel Operation'
    }
};

function getMainMenu() {
    let menu = '*PDF Bot Commands*\n\n';
    Object.entries(commands.main).forEach(([number, description]) => {
        menu += `*${number}*: ${description}\n`;
    });
    menu += '\nType "menu" anytime to see this list again.';
    return menu;
}

// Helper Functions
async function convertImageToPdf(message, media) {
    try {
        if (!media || !media.mimetype.includes('image')) {
            throw new Error('Invalid media type');
        }

        const imageFileName = path.join(uploadDir, `${Date.now()}.${media.mimetype.split('/')[1]}`);
        fs.writeFileSync(imageFileName, media.data, 'base64');

        const dimension = sizeOf(imageFileName);
        const pdfFileName = path.join(uploadDir, `${Date.now()}.pdf`);

        const doc = new PDFDocument({
            size: [dimension.width, dimension.height]
        });
        doc.image(imageFileName, 0, 0);
        doc.pipe(fs.createWriteStream(pdfFileName));
        doc.end();

        await new Promise(resolve => setTimeout(resolve, 1000));

        const pdfMedia = MessageMedia.fromFilePath(pdfFileName);
        await message.reply(pdfMedia, null, {
            caption: '✅ Here is your PDF!'
        });

        // Cleanup
        fs.unlinkSync(imageFileName);
        fs.unlinkSync(pdfFileName);
        
        return true;
    } catch (error) {
        console.error('Error converting image:', error);
        throw error;
    }
}

async function mergePDFs(pdfs) {
    try {
        const mergedDoc = await PDFLib.create();
        
        for (const pdf of pdfs) {
            const pdfDoc = await PDFLib.load(Buffer.from(pdf.data, 'base64'));
            const pages = await mergedDoc.copyPages(pdfDoc, pdfDoc.getPageIndices());
            pages.forEach(page => mergedDoc.addPage(page));
        }

        const mergedPdfBytes = await mergedDoc.save();
        const outputPath = path.join(uploadDir, `merged-${Date.now()}.pdf`);
        fs.writeFileSync(outputPath, mergedPdfBytes);
        
        return outputPath;
    } catch (error) {
        console.error('Error merging PDFs:', error);
        throw error;
    }
}

async function compressPDF(pdfBuffer) {
    try {
        // Load the PDF document
        const pdfDoc = await PDFLib.load(pdfBuffer);
        
        // Compress the PDF using PDF-lib's compression options
        const compressedPdfBytes = await pdfDoc.save({
            useObjectStreams: true,
            addDefaultPage: false,
            objectsPerTick: 100,
            updateFieldAppearances: false
        });

        // Save the compressed PDF
        const outputPath = path.join(uploadDir, `${Date.now()}-compressed.pdf`);
        fs.writeFileSync(outputPath, compressedPdfBytes);
        
        return outputPath;
    } catch (error) {
        console.error('Error compressing PDF:', error);
        throw error;
    }
}

async function handlePDFCompression(message, media) {
    try {
        if (!media || media.mimetype !== 'application/pdf') {
            throw new Error('Invalid media type');
        }

        await message.reply('🗜️ Compressing your PDF...');
        
        // Get original file size
        const originalBuffer = Buffer.from(media.data, 'base64');
        const originalSize = originalBuffer.length;

        // Compress the PDF
        const compressedPath = await compressPDF(originalBuffer);
        
        // Get compressed file size
        const compressedSize = fs.statSync(compressedPath).size;
        
        // Calculate compression percentage
        const compressionPercent = ((originalSize - compressedSize) / originalSize * 100).toFixed(1);
        
        const compressedPDF = MessageMedia.fromFilePath(compressedPath);
        await message.reply(compressedPDF, null, { 
            caption: `✅ PDF compressed successfully!\nReduced by ${compressionPercent}% (${(originalSize/1048576).toFixed(2)}MB → ${(compressedSize/1048576).toFixed(2)}MB)`
        });

        // Cleanup
        fs.unlinkSync(compressedPath);
        
        return true;
    } catch (error) {
        console.error('Error handling PDF compression:', error);
        throw error;
    }
}

// Event Handlers
client.on('qr', (qr) => {
    console.log('QR Code received, please scan:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('PDF Bot is ready!');
});

client.on('message', async (message) => {
    try {
        const command = message.body.trim().toLowerCase();
        const userId = message.from;
        const userState = userStateManager.getState(userId);
        const currentState = userState?.state || STATES.IDLE;

        // Only respond to menu command if user is in IDLE state
        if (command === 'menu' && currentState === STATES.IDLE) {
            await message.reply(getMainMenu());
            return;
        }

        // Handle cancel command
        if (command === '5') {
            if (currentState !== STATES.IDLE) {
                userStateManager.clearState(userId);
                await message.reply('✅ Operation cancelled. Type "menu" to start again.');
            }
            return;
        }

        // Only process commands if in IDLE state or if there's an active operation
        if (currentState === STATES.IDLE) {
            switch (command) {
                case '1':
                    userStateManager.setState(userId, STATES.AWAITING_IMAGE);
                    await message.reply('📸 Please send the image you want to convert to PDF.');
                    break;
                case '2':
                    userStateManager.setState(userId, STATES.AWAITING_PDF_MERGE);
                    await message.reply('🔄 Please send your PDFs one by one (maximum 2). Send "done" when finished or "5" to cancel.');
                    break;
                case '3':
                    userStateManager.setState(userId, STATES.AWAITING_PDF_COMPRESS);
                    await message.reply('🗜️ Please send the PDF you want to compress.');
                    break;
                case '4':
                    await message.reply('PDF Bot created by Aryan. Version 2.0\nType "menu" to see available commands.');
                    break;
                default:
                    // Don't respond to unknown commands in IDLE state
                    return;
            }
        } else {
            // Handle active states
            switch (currentState) {
                case STATES.AWAITING_IMAGE:
                    if (message.hasMedia) {
                        await message.reply('🔄 Processing your image...');
                        const media = await message.downloadMedia();
                        try {
                            await convertImageToPdf(message, media);
                            userStateManager.clearState(userId);
                        } catch (error) {
                            await message.reply('❌ Failed to convert image. Please make sure you sent a valid image file.');
                        }
                    }
                    break;

                case STATES.AWAITING_PDF_MERGE:
                    if (command === 'done') {
                        const pdfs = userStateManager.getPDFs(userId);
                        if (pdfs.length < 2) {
                            await message.reply('❌ Please send at least 2 PDFs to merge.');
                            return;
                        }
                        await message.reply('🔄 Merging PDFs...');
                        try {
                            const mergedPath = await mergePDFs(pdfs);
                            const mergedPDF = MessageMedia.fromFilePath(mergedPath);
                            await message.reply(mergedPDF, null, { caption: '✅ PDFs merged successfully!' });
                            fs.unlinkSync(mergedPath);
                            userStateManager.clearState(userId);
                        } catch (error) {
                            await message.reply('❌ Failed to merge PDFs. Please try again.');
                        }
                    } else if (message.hasMedia) {
                        const media = await message.downloadMedia();
                        if (media.mimetype === 'application/pdf') {
                            userStateManager.addPDF(userId, media);
                            const pdfCount = userStateManager.getPDFs(userId).length;
                            if (pdfCount >= 2) {
                                await message.reply('🔄 Merging PDFs...');
                                try {
                                    const mergedPath = await mergePDFs(userStateManager.getPDFs(userId));
                                    const mergedPDF = MessageMedia.fromFilePath(mergedPath);
                                    await message.reply(mergedPDF, null, { caption: '✅ PDFs merged successfully!' });
                                    fs.unlinkSync(mergedPath);
                                    userStateManager.clearState(userId);
                                } catch (error) {
                                    await message.reply('❌ Failed to merge PDFs. Please try again.');
                                }
                            } else {
                                await message.reply(`✅ PDF ${pdfCount} received. Please send another PDF or type "done" when finished.`);
                            }
                        } else {
                            await message.reply('❌ Please send a PDF file.');
                        }
                    }
                    break;

                case STATES.AWAITING_PDF_COMPRESS:
                    if (message.hasMedia) {
                        const media = await message.downloadMedia();
                        try {
                            await handlePDFCompression(message, media);
                            userStateManager.clearState(userId);
                        } catch (error) {
                            await message.reply('❌ Failed to compress PDF. Please make sure you sent a valid PDF file.');
                        }
                    }
                    break;
            }
        }
    } catch (error) {
        console.error('Error handling message:', error);
        await message.reply('❌ An error occurred. Please type "menu" to start over.');
        userStateManager.clearState(message.from);
    }
});

// Initialize the client
client.initialize();