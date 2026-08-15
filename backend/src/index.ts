import express, { type Request, type Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { PrismaClient } from '../generated/client';

dotenv.config();

const app = express();
const port = Number(process.env.PORT ?? 5000);

if (!process.env.GEMINI_API_KEY) {
  throw new Error('GEMINI_API_KEY est requis. Vérifiez votre fichier .env.');
}

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL est requis pour Prisma. Vérifiez votre fichier .env.');
}

const prisma = new PrismaClient({
  accelerateUrl: process.env.DATABASE_URL,
});
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/', (_req: Request, res: Response) => {
  res.json({ message: 'Bienvenue sur l’API PawDr - DEV Challenge' });
});

const normalizeAiResponse = (rawText: string) => {
  const cleanJsonText = rawText
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  const parsed = JSON.parse(cleanJsonText);

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Réponse IA invalide : le JSON est vide ou mal formé.');
  }

  return {
    breed: String(parsed.breed ?? 'Inconnue'),
    temperament: String(parsed.temperament ?? 'Tempérament non spécifié.'),
    careTips: String(parsed.careTips ?? 'Aucun conseil disponible.'),
  };
};

app.post('/api/scan', async (req: Request, res: Response) => {
  try {
    const { imageBase64, imageUrl } = req.body as {
      imageBase64?: string;
      imageUrl?: string;
    };

    if (!imageBase64 && !imageUrl) {
      return res.status(400).json({
        success: false,
        error: 'Aucune image fournie. Envoyez imageBase64 ou imageUrl.',
      });
    }

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: {
        responseMimeType: 'application/json',
      },
    });

    const prompt = `Analyse cette image de chien. Réponds uniquement avec un JSON valide, sans markdown ni texte supplémentaire.
    Structure exacte :
    {
      "breed": "Nom de la race ou 'Inconnue'",
      "temperament": "Description concise du tempérament",
      "careTips": "Conseils d'entretien essentiels"
    }
    Règles :
    - Si la race est incertaine, utilise 'Inconnue'.
    - La réponse doit être exploitable directement en JavaScript via JSON.parse().
    - Ne mets pas de commentaires, de guillemets inutiles ou de code fences.`;

    const result = imageBase64
      ? await model.generateContent([
          prompt,
          {
            inlineData: {
              data: imageBase64.includes('data:')
                ? imageBase64.split(',')[1]
                : imageBase64,
              mimeType: imageBase64.includes('data:')
                ? imageBase64.match(/^data:(image\/(png|jpeg|jpg|webp));base64,/)?.[1] ?? 'image/jpeg'
                : 'image/jpeg',
            },
          },
        ])
      : await model.generateContent([
          prompt,
          {
            fileData: {
              fileUri: imageUrl ?? '',
              mimeType: 'image/jpeg',
            },
          },
        ]);
    const aiData = normalizeAiResponse(result.response.text());

    const persistedScan = process.env.DATABASE_URL
      ? await prisma.dogScan.create({
          data: {
            imageUrl: imageUrl ?? 'base64_upload',
            breed: aiData.breed,
            temperament: aiData.temperament,
            careTips: aiData.careTips,
          },
        })
      : null;

    return res.json({
      success: true,
      data: persistedScan ?? aiData,
    });
  } catch (error) {
    console.error('Erreur lors de l’analyse IA :', error);

    const message = error instanceof Error ? error.message : 'Erreur inconnue';
    return res.status(500).json({ success: false, error: message });
  }
});

const shutdown = async () => {
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

app.listen(port, () => {
  console.log(`Serveur PawDr démarré sur le port ${port}`);
});
