* PROCESS GS,INCLUDE;
 KVIZ001: PROC(COMAREA) OPTIONS(MAIN,BYVALUE);

 /* ****************************************************************
  *  PROGRAM ADI         : KVIZ001                                 *
  *  TXN ID              : KVIZ                                    *
  *  PROGRAMI YAZAN      : FÜSUN BAKIM                             *
  *  YAZIM TARİHİ        : 06/12/2001                              *
  *  AÇIKLAMA            : KURUMSAL VİZYON PROJESİNDE KURUMSAL     *
  *                        MÜŞTERİLERE AİT TÜM TOPLAM BİLGİLERİNİ  *
  *                        İLGİLİ PROGRAMLARI CALL EDEREK,         *
  *                        İNTERNET'E GÖNDERİR.                    *
  * -------------------------------------------------------------- *
  * UPDATE TARİHİ        : 25.2.2003                               *
  * UPDATE EDEN          : FÜSUN BAKIM                             *
  * UPDATE NEDENİ        : AJANDAYA SERMAYE ARTTIRIM BİLGİLERİ     *
  *                        EKLENDİ. (HSP239)                       *
  * -------------------------------------------------------------- *
  * UPDATE TARİHİ        : 6.11.2003                               *
  * UPDATE EDEN          : FÜSUN BAKIM                             *
  * UPDATE NEDENİ        : PİYASA BİLGİLERİ KİŞİSELLEŞTİRME BİLGİ- *
  *                        LERİNİN GÖNDERİLMESİ (KSSL004)          *
  * -------------------------------------------------------------- *
  * UPDATE TARİHİ        : 21.9.2004                               *
  * UPDATE EDEN          : FÜSUN BAKIM                             *
  * UPDATE NEDENİ        : YTL REVİZELERİ.                         *
  * -------------------------------------------------------------- *
  * UPDATE TARİHİ        : 6.12.2004                               *
  * UPDATE EDEN          : FÜSUN BAKIM                             *
  * UPDATE NEDENİ        : YTL REVİZELERİ VE REPO FİYAT GÖRÜNTÜLEME*
  *                        İÇİN GÜNÜ 1'DEN BÜYÜK FİYATLARI SEÇER.  *
  * -------------------------------------------------------------- *
  * UPDATE TARİHİ        : 8.8.2005                                *
  * UPDATE EDEN          : FÜSUN BAKIM                             *
  * UPDATE NEDENİ        : ZERODIVIDE HATASI (ASRA) NEDENİYLE      *
  *                        REVİZE YAPILDI.                         *
  * -------------------------------------------------------------- *
  * UPDATE TARİHİ        : 25.5.2006                               *
  * UPDATE EDEN          : FÜSUN BAKIM                             *
  * UPDATE NEDENİ        : PARITE_BUL_2 PROC.'UNDA ASRA ALMASI     *
  *                        NEDENİYLE REVİZE YAPILDI. (ZERODIVIDE)  *
  * -------------------------------------------------------------- *
  * UPDATE TARİHİ        : 14.08.2007                              *
  * UPDATE EDEN          : FÜSUN BAKIM                             *
  * UPDATE NEDENİ        : NEW AGE ŞUBE KODU DIGIT ARTTIRIMI.      *
  * -------------------------------------------------------------- *
  * UPDATE TARİHİ        : 25.09.2007                              *
  * UPDATE EDEN          : FÜSUN BAKIM                             *
  * UPDATE NEDENİ        : NEW AGE - MKGUN_RSORAN RSO_SUBE SAHASI- *
  *                        NIN 3 BYTE'TAN 5 BYTE'A ÇIKARILMASI.    *
  * -------------------------------------------------------------- *
  * UPDATE TARİHİ        : 30.12.2008                              *
  * UPDATE EDEN          : HAMİDE İREM ÖZKEKLİKÇİ                  *
  * UPDATE NEDENİ        : GO TL PROJESİ YTL - TL DÖNÜŞÜMÜ         *
  * -------------------------------------------------------------- *
  * UPDATE TARİHİ        : 20.07.2009                              *
  * UPDATE EDEN          : FÜSUN BAKIM                             *
  * UPDATE NEDENİ        : TELMESSOS PROJESİ KAPSAMINDA ALTIN ALIŞ *
  *                        ALTIN SATIŞ FİYATININ GÖNDERİLMESİ.     *
  *                        COMMAREA DEĞİŞİKLİĞİ VAR.               *
  * -------------------------------------------------------------- *
  * UPDATE TARİHİ        : 16.02.2010                              *
  * UPDATE EDEN          : FÜSUN BAKIM                             *
  * UPDATE NEDENİ        : 12960-988-571 BİM KAPSAMINDA DÖVİZ KUR- *
  *                        LARI KUR_TIP_KODU 'I' OLAN KAYITLAR     *
  *                        OKUNACAK.                               *
  * -------------------------------------------------------------- *
  * UPDATE TARİHİ        : 19.03.2010                              *
  * UPDATE EDEN          : İREM ÖZKEKLİKÇİ                         *
  * UPDATE NEDENİ        : FON 9 EKLENMESİ KAPSAMINDA FON SAYISI   *
  *                        15 E ÇIKARILADI                         *
  * -------------------------------------------------------------- *
  * REVİZE EDEN          : FÜSUN BAKIM                             *
  * REVİZE TARİHİ        : 07.06.2011                              *
  * REVİZE NEDENİ        : 18552-909-370  BİM KAPSAMINDA "H1"      *
  *                        FON TÜRÜNÜN EKLENMESİ.                  *
  * -------------------------------------------------------------- *
  * REVİZE EDEN          : FÜSUN BAKIM                             *
  * REVİZE TARİHİ        : 20.07.2012                              *
  * REVİZE NEDENİ        : YP EXTRE PROJESİ KAPSAMINDA DEĞİŞİKLİK. *
  *                        KVKK001 VE MIVI006 DA REVİZE EDİLECEK.  *
  * -------------------------------------------------------------- *
  * REVİZE EDEN          : FÜSUN BAKIM                             *
  * REVİZE TARİHİ        : 07.07.2014                              *
  * REVİZE NEDENİ        : SİCİLYA PROJESİ KAPSAMINDA SICIL NO     *
  *                        SAHASI 8, MAIL SAHASI 60 KARAKTER       *
  *                        OLARAK DEĞİŞTİRİLDİ.                    *
  *                        COMMAREA DEĞİŞİKLİĞİ VAR.               *
  * -------------------------------------------------------------- *
  * REVİZE EDEN          : FÜSUN BAKIM                             *
  * REVİZE TARİHİ        : 24.07.2014                              *
  * REVİZE NEDENİ        : 23969 BİM bimi kapsamında, slave olarak *
  *                        özel kullanıcının gelmesi durumunda     *
  *                        yapılacak revize..(KSSL004 de değişecek)*
  *                        COMMAREA DEĞİŞİKLİĞİ VAR.               *  
  * -------------------------------------------------------------- *
  * REVİZE EDEN          : BURAK ÖZER                              *
  * REVİZE TARİHİ        : 19.12.2023                              *
  * REVİZE NEDENİ        : SERMAYE ARTIRIMI(HSP239 ÇAĞRISI)        *
  *						   PERFORMANS SORUNU SEBEBİYLE KALDIRILMASI*
  *						   TLP-26051  							   *         
  * ************************************************************** *
  * REVİZE EDEN          : BURAK ÖZER                              *
  * REVİZE TARİHİ        : 07.03.2025                              *
  * REVİZE NEDENİ        : GÜMÜŞ PROJESİ        		   		   *
  *						   PRJ-0685								   *     
  * ************************************************************** */

 DCL (STG,SUBSTR,DATE,CSTG,ADDR,NULL,TIME,MULTIPLY,DIVIDE,VERIFY,LOW,
      TRANSLATE,DATETIME) BUILTIN;

 DCL COMAREA POINTER,      /* INTERNETE AIT COMMAREA */
     1 COM_AREA  BASED(COMAREA),
       2 COM_KVIZ_HATA       PIC'S999',
       2 COM_KVIZ_TABLO_ADI  CHAR(18),
       2 COM_PIYASA_RC       PIC'99',
       2 COM_PIYA_HATA_ACK   CHAR(25),
       2 COM_MUST_NO         PIC'9999999999',
       2 COM_SLAVE_MUST_NO   PIC'9999999999',
       2 COM_OZL_KULL_KOD    CHAR(10), 
       2 COM_MINVADE         CHAR(10),
       2 COM_MAXVADE         CHAR(10),
       2 COM_PERIYOT         CHAR(1),
       2 COM_MIY_AD          CHAR(20),
       2 COM_MIY_SOYAD       CHAR(20),
       2 COM_MIY_SICIL       CHAR(8),
       2 COM_MIY_CEPTEL      CHAR(17),
       2 COM_MIY_ISTEL       CHAR(17),
       2 COM_MIY_MAIL        CHAR(60),
       2 COM_MIY_DUYURU      CHAR(300),
       2 COM_MIY_FOTO        CHAR(1),  /* E-VAR, H-YOK */
       2 COM_SOZLESME        CHAR(1),
       2 COM_FILLER,
         3 COM_PRG_AD        CHAR(8),
         3 COM_FILLER        CHAR(42),
       2 COM_PYS_KOLON_NO    PIC'9',
       2 COM_PYS_SIRA_NO     PIC'99',
       2 COM_F2_ALIS         PIC'S99999999V999999',
       2 COM_F2_SATIS        PIC'S99999999V999999',
       2 COM_F3_ALIS         PIC'S99999999V999999',
       2 COM_F3_SATIS        PIC'S99999999V999999',
       2 COM_F4_ALIS         PIC'S99999999V999999',
       2 COM_F4_SATIS        PIC'S99999999V999999',
       2 COM_F5_ALIS         PIC'S99999999V999999',
       2 COM_F5_SATIS        PIC'S99999999V999999',
       2 COM_F6_ALIS         PIC'S99999999V999999',
       2 COM_F6_SATIS        PIC'S99999999V999999',
       2 COM_F7_ALIS         PIC'S99999999V999999',
       2 COM_F7_SATIS        PIC'S99999999V999999',
       2 COM_F8_ALIS         PIC'S99999999V999999',
       2 COM_F8_SATIS        PIC'S99999999V999999',
       2 COM_F9_ALIS         PIC'S99999999V999999',
       2 COM_F9_SATIS        PIC'S99999999V999999',
       2 COM_H1_ALIS         PIC'S99999999V999999',
       2 COM_H1_SATIS        PIC'S99999999V999999',
       2 COM_H2_ALIS         PIC'S99999999V999999',
       2 COM_H2_SATIS        PIC'S99999999V999999',
       2 COM_H3_ALIS         PIC'S99999999V999999',
       2 COM_H3_SATIS        PIC'S99999999V999999',
       2 COM_H4_ALIS         PIC'S99999999V999999',
       2 COM_H4_SATIS        PIC'S99999999V999999',
       2 COM_H5_ALIS         PIC'S99999999V999999',
       2 COM_H5_SATIS        PIC'S99999999V999999',
       2 COM_H6_ALIS         PIC'S99999999V999999',
       2 COM_H6_SATIS        PIC'S99999999V999999',
       2 COM_REPO_ORAN       PIC'S99999V99',
       2 COM_REPO_GUN        PIC'999',
       2 COM_USD_ALIS        PIC'S99999999V9999999', /* YTL REVIZE */
       2 COM_USD_SATIS       PIC'S99999999V9999999', /* YTL REVIZE */
       2 COM_USD_ARTIS       CHAR(1),
       2 COM_EUR_ALIS        PIC'S99999999V9999999', /* YTL REVIZE */
       2 COM_EUR_SATIS       PIC'S99999999V9999999', /* YTL REVIZE */
       2 COM_EUR_ARTIS       CHAR(1),
       2 COM_ALTTL_ALIS      PIC'S99999999V9999999', /* 20.07.2009 */
       2 COM_ALTTL_SATIS     PIC'S99999999V9999999', /* 20.07.2009 */
       2 COM_ALTUSD_ALIS     PIC'S99999999V9999999', /* 20.07.2009 */
       2 COM_ALTUSD_SATIS    PIC'S99999999V9999999', /* 20.07.2009 */
       2 COM_ALTEUR_ALIS     PIC'S99999999V9999999', /* 20.07.2009 */
       2 COM_ALTEUR_SATIS    PIC'S99999999V9999999', /* 20.07.2009 */
       2 COM_GMSTL_ALIS      PIC'S99999999V9999999', /* 06.03.2025 */
       2 COM_GMSTL_SATIS     PIC'S99999999V9999999', /* 06.03.2025 */
       2 COM_GMSUSD_ALIS     PIC'S99999999V9999999', /* 06.03.2025 */
       2 COM_GMSUSD_SATIS    PIC'S99999999V9999999', /* 06.03.2025 */
       2 COM_GMSEUR_ALIS     PIC'S99999999V9999999', /* 06.03.2025 */
       2 COM_GMSEUR_SATIS    PIC'S99999999V9999999', /* 06.03.2025 */
       2 COM_AJN_KOLON_NO    PIC'9',
       2 COM_AJN_SIRA_NO     PIC'99',
       2 COM_BV05_HATA       PIC'99',
       2 COM_BV05_HATA_ACIK  CHAR(15),
       2 COM_AJAND_20        CHAR(1),
       2 COM_AJAND(20),
         3 COM_DVZ           CHAR(03),
         3 COM_VADE          CHAR(10),
         3 COM_SAAT          CHAR(4),
         3 COM_ACIKLAMA      CHAR(42),
         3 COM_TUTARJ        PIC'S(15)9V99', /* 3.1.2005 YTL REVIZE */
         3 COM_SIRANO        PIC'999999',
       2 COM_ARRAY(60),
         3 COM_RC            PIC'S999',
         3 COM_TABLO_ADI     CHAR(18),
         3 COM_CALISMA_KOD   CHAR(1),
         3 COM_KOLON_NO      PIC'9',
         3 COM_SIRA_NO       PIC'99',
         3 COM_KRITER_NO     PIC'999',
         3 COM_GRUP_KOD      CHAR(1),
         3 COM_DVZ_TIP       CHAR(3),
         3 COM_TUTAR         PIC'S999999999999999V99',
         3 COM_ADET          PIC'99999',
       2 COM_USD_EUR_PAR     FIXED DEC(15,7), /* YTL REVIZE */
       2 COM_MARKET_INFO(20),
          3 COM_ICERIK_KOD       CHAR(06),
          3 COM_ICERIK_TIP_KOD   CHAR(1);

 DCL 1 COM_DIGER,          /* CALL EDILECEK PROGRAMLARA AİT COMMAREA */
       2 DCOM_MUST_NO        PIC'9999999999',
       2 DCOM_MINVADE        CHAR(10),
       2 DCOM_MAXVADE        CHAR(10),
       2 DCOM_SLAVE_MUST_NO  PIC'9999999999',
       2 DCOM_FILLER         CHAR(50),
       2 DCOM_ARRAY(30),
         3 DCOM_RC           PIC'S999',
         3 DCOM_TABLO_ADI    CHAR(18),
         3 DCOM_KRITER_NO    PIC'999',
         3 DCOM_GRUP_KOD     CHAR(1),
         3 DCOM_DVZ_KOD      PIC'9999',
         3 DCOM_TUTAR        PIC'S999999999999999V99',
         3 DCOM_ADET         PIC'99999';

 DCL 1 COM_BVIZ,
       2 COM_BVIZ_HATA       PIC'99',
       2 COM_BVIZ_HATA_ACIK  CHAR(15),
       2 COM_BVIZ_MUST_NO    PIC'99999999',
       2 COM_BVIZ_AJAND_20   CHAR(1),
       2 COM_BVIZ_AJAND(20),
         3 COM_BVIZ_DVZ      CHAR(03),
         3 COM_BVIZ_VADE     CHAR(10),
         3 COM_BVIZ_SAAT     CHAR(4),
         3 COM_BVIZ_ACIKLAMA CHAR(42),
         3 COM_BVIZ_TUTAR    FIXED DEC(17,2), /* 3.1.2005 YTL REVIZE */
         3 COM_BVIZ_SIRANO   PIC'999999';

 DCL 1 COM_KSSL,
       2 COM_KSSL_MUST_NO        FIXED DEC(10),
       2 COM_KSSL_RC             PIC'(2)9',
       2 COM_KSSL_HATA           CHAR(15),
       2 COM_KSSL_USD_ALIS       FIXED DEC(15,7),
       2 COM_KSSL_USD_SATIS      FIXED DEC(15,7),
       2 COM_KSSL_USD_ARTIS      CHAR(1),
       2 COM_KSSL_EUR_ALIS       FIXED DEC(15,7),
       2 COM_KSSL_EUR_SATIS      FIXED DEC(15,7),
       2 COM_KSSL_EUR_ARTIS      CHAR(1),
       2 COM_KSSL_USD_EUR_PAR    FIXED DEC(15,7),
       2 COM_KSSL_ALTTL_ALIS     FIXED DEC(15,7),  /* 20.07.2009 */
       2 COM_KSSL_ALTTL_SATIS    FIXED DEC(15,7),  /* 20.07.2009 */
       2 COM_KSSL_ALTUSD_ALIS    FIXED DEC(15,7),  /* 20.07.2009 */
       2 COM_KSSL_ALTUSD_SATIS   FIXED DEC(15,7),  /* 20.07.2009 */
       2 COM_KSSL_ALTEUR_ALIS    FIXED DEC(15,7),  /* 20.07.2009 */
       2 COM_KSSL_ALTEUR_SATIS   FIXED DEC(15,7),  /* 20.07.2009 */
	   2 COM_KSSL_GMSTL_ALIS     FIXED DEC(15,7),  /* 31.01.2025 */
       2 COM_KSSL_GMSTL_SATIS    FIXED DEC(15,7),  /* 31.01.2025 */
       2 COM_KSSL_GMSUSD_ALIS    FIXED DEC(15,7),  /* 31.01.2025 */
       2 COM_KSSL_GMSUSD_SATIS   FIXED DEC(15,7),  /* 31.01.2025 */
       2 COM_KSSL_GMSEUR_ALIS    FIXED DEC(15,7),  /* 31.01.2025 */
       2 COM_KSSL_GMSEUR_SATIS   FIXED DEC(15,7),  /* 31.01.2025 */
       2 COM_KSSL_F2_ALIS        FIXED DEC(10,6),
       2 COM_KSSL_F2_SATIS       FIXED DEC(10,6),
       2 COM_KSSL_F3_ALIS        FIXED DEC(10,6),
       2 COM_KSSL_F3_SATIS       FIXED DEC(10,6),
       2 COM_KSSL_F4_ALIS        FIXED DEC(10,6),
       2 COM_KSSL_F4_SATIS       FIXED DEC(10,6),
       2 COM_KSSL_F5_ALIS        FIXED DEC(10,6),
       2 COM_KSSL_F5_SATIS       FIXED DEC(10,6),
       2 COM_KSSL_F6_ALIS        FIXED DEC(10,6),
       2 COM_KSSL_F6_SATIS       FIXED DEC(10,6),
       2 COM_KSSL_F7_ALIS        FIXED DEC(10,6),
       2 COM_KSSL_F7_SATIS       FIXED DEC(10,6),
       2 COM_KSSL_F8_ALIS        FIXED DEC(10,6),
       2 COM_KSSL_F8_SATIS       FIXED DEC(10,6),
       2 COM_KSSL_F9_ALIS        FIXED DEC(10,6),
       2 COM_KSSL_F9_SATIS       FIXED DEC(10,6),
       2 COM_KSSL_H1_ALIS        FIXED DEC(10,6),
       2 COM_KSSL_H1_SATIS       FIXED DEC(10,6),
       2 COM_KSSL_H2_ALIS        FIXED DEC(10,6),
       2 COM_KSSL_H2_SATIS       FIXED DEC(10,6),
       2 COM_KSSL_H3_ALIS        FIXED DEC(10,6),
       2 COM_KSSL_H3_SATIS       FIXED DEC(10,6),
       2 COM_KSSL_H4_ALIS        FIXED DEC(10,6),
       2 COM_KSSL_H4_SATIS       FIXED DEC(10,6),
       2 COM_KSSL_H5_ALIS        FIXED DEC(10,6),
       2 COM_KSSL_H5_SATIS       FIXED DEC(10,6),
       2 COM_KSSL_H6_ALIS        FIXED DEC(10,6),
       2 COM_KSSL_H6_SATIS       FIXED DEC(10,6),
       2 COM_KSSL_H7_ALIS        FIXED DEC(10,6), /* 31.01.2025 */
       2 COM_KSSL_H7_SATIS       FIXED DEC(10,6), /* 31.01.2025 */
       2 COM_KSSL_REPO_ORAN      FIXED DEC(7,2),
       2 COM_KSSL_REPO_GUN       FIXED DEC(3,0),
       2 COM_KSSL_MARKET_INFO(20),
          3 COM_KSSL_ICERIK_KOD      CHAR(06),
          3 COM_KSSL_ICERIK_TIP      CHAR(1);

 DCL WDATE1                  CHAR(10)          INIT(' '),
     WDATE2                  CHAR(10)          INIT(' '),
     WDATE3                  CHAR(10)          INIT(' '),
     WMIN_VADE               CHAR(10)          INIT(' '),
     WMAX_VADE               CHAR(10)          INIT(' '),
     TEMP_BVIZ_VADE          CHAR(10)          INIT(' '),
     WSICIL_NO               CHAR(8)           INIT(' '),
     TRL_YTL                 CHAR(3)           INIT(' '),
     WPERS_AD                CHAR(20)          INIT(' '),
     WPERS_SOYAD             CHAR(20)          INIT(' '),
     WDVZ_TIP                CHAR(3)           INIT(' '),
     SQLCODE_PIC             PIC'S999'         INIT(0),
     WDVZ_KOD                FIXED BIN(15)     INIT(0),
     WMUST_NO                FIXED BIN(31)     INIT(0),
     WSLAVE_MUST_NO          FIXED BIN(31)     INIT(0),
     WPERS_MUST_NO           FIXED BIN(31)     INIT(0),
     RESP_CODE               FIXED BIN(31)     INIT(0),
     FMUST_NO                FIXED DEC(10)     INIT(0),
     NDX                     FIXED DEC(3)      INIT(0),
     INDX                    FIXED DEC(3)      INIT(0),
     I                       FIXED DEC(3)      INIT(0),
     II                      FIXED DEC(3)      INIT(0),
     LL                      FIXED DEC(3)      INIT(0),
     WYFN_MKTUR              CHAR(2),
     WYFN_ALIS_FIYAT         FIXED DEC(15,6)   INIT(0),
     WYFN_SATIS_FIYAT        FIXED DEC(15,6)   INIT(0),
     WRSO_ORAN1              FIXED DEC(7,2)    INIT(0),
     WRSO_GUN1               FIXED DEC(3,0)    INIT(0),
     WRSO_SUBE               CHAR(5)           INIT(' '),
     WDVZ_SATIS              FIXED DEC(15,7)   INIT(0),
     WDVZ_ALIS               FIXED DEC(15,7)   INIT(0),
     WDVZ_SATIS2             FIXED DEC(15,7)   INIT(0),
     WDVZ_ALIS2              FIXED DEC(15,7)   INIT(0),
     ESKI_KRITER_NO          PIC'999'          INIT(0),
     ESKI_GRUP_KOD           CHAR(1)           INIT(' '),
     ESKI_DVZ_KOD            FIXED BIN(15)     INIT(0),
     ISTENEN_DVZ_KOD         FIXED BIN(15)     INIT(9010),
     ISTENEN_DVZ_TIP         CHAR(3)           INIT('USD'),
     ISTENEN_DVZ_STS         FIXED DEC(15,7)   INIT(0),
     ISTENEN_DVZ_ALS         FIXED DEC(15,7)   INIT(0),
     PARITE                  FIXED DEC(15,8)   INIT(0),
     PARITE_KARSILIK         FIXED DEC(17,2)   INIT(0),
     TL_TUTAR                FIXED DEC(17,2)   INIT(0),
     TL_ADET                 FIXED DEC(5)      INIT(0),
     YP_TUTAR                FIXED DEC(17,2)   INIT(0),
     YP_ADET                 FIXED DEC(5)      INIT(0),
     TL_KARSILIK             FIXED DEC(17,2)   INIT(0),
     YP_KARSILIK             FIXED DEC(17,2)   INIT(0),
     TEMP_TUTAR              FIXED DEC(17,2)   INIT(0),
     TL_BULDUM               FIXED DEC(1)      INIT(0),
     YP_BULDUM               FIXED DEC(1)      INIT(0),
     ISL_KUR                 FIXED DEC(15,7)   INIT(0),
     TEMP_RC                 PIC'S999'         INIT(0),
     TEMP_TABLO_ADI          CHAR(18)          INIT(' '),
     WINTERNET_ID            CHAR(60)          INIT(' '),
     WRESIM_FLAG             CHAR(1)           INIT(' '),
     WIS_TEL                 CHAR(17)          INIT(' '),
     WCEP_TEL_NO             CHAR(17)          INIT(' '),
     WMESAJ_TNM              CHAR(300)         INIT(' '),
     JJ                      FIXED DEC(3)      INIT(0),
     WCOUNT                  FIXED DEC(5)      INIT(0),
     WKISISEL_ADET           FIXED DEC(5)      INIT(0),
     KISISEL_FLAG            CHAR(1)           INIT(' '),
     SOZLESME_FLAG           CHAR(1)           INIT(' '),
     WBILGI_KOD              CHAR(1)           INIT(' '),
     WBILGI_DETAY            CHAR(7)           INIT(' '),
     WSATIR_NO               FIXED BIN(15)     INIT(0),
     WSUTUN_NO               FIXED BIN(15)     INIT(0),
     H_FLAG                  CHAR(1)           INIT('H'),
     K_FLAG                  CHAR(1)           INIT('H'),
     I_FLAG                  CHAR(1)           INIT('H'),
     D_FLAG                  CHAR(1)           INIT('H'),
     O_FLAG                  CHAR(1)           INIT('H'),
     T_FLAG                  CHAR(1)           INIT('H'),
     M_FLAG                  CHAR(1)           INIT('H'),
     J_FLAG                  CHAR(1)           INIT('H'),
     Y_FLAG                  CHAR(1)           INIT('H'),
     WPERIYOT                CHAR(1)           INIT('1'),
     H_KOLON                 PIC'9'            INIT(0),
     K_KOLON                 PIC'9'            INIT(0),
     I_KOLON                 PIC'9'            INIT(0),
     D_KOLON                 PIC'9'            INIT(0),
     O_KOLON                 PIC'9'            INIT(0),
     T_KOLON                 PIC'9'            INIT(0),
     M_KOLON                 PIC'9'            INIT(0),
     J_KOLON                 PIC'9'            INIT(0),
     Y_KOLON                 PIC'9'            INIT(0),
     H_SIRA                  PIC'99'           INIT(0),
     K_SIRA                  PIC'99'           INIT(0),
     I_SIRA                  PIC'99'           INIT(0),
     D_SIRA                  PIC'99'           INIT(0),
     O_SIRA                  PIC'99'           INIT(0),
     T_SIRA                  PIC'99'           INIT(0),
     M_SIRA                  PIC'99'           INIT(0),
     J_SIRA                  PIC'99'           INIT(0),
     Y_SIRA                  PIC'99'           INIT(0),
     WDUMMY                  CHAR(10);

 DCL DVZ_KOD_ARR(80)         FIXED BIN(15),
     DVZ_TIP_ARR(80)         CHAR(3),
     DVZ_STS_ARR(80)         FIXED DEC(15,7),
     DVZ_ALS_ARR(80)         FIXED DEC(15,7);

 DCL WMUST_NO_OZL            FIXED BIN(31)     INIT(0);
     
 
 EXEC SQL INCLUDE SQLCA;
 EXEC SQL INCLUDE OINCL017;

 CALL OINCL017_COMMAREA_KONTROL(SIZE(COM_AREA),
 								COM_KVIZ_HATA, COM_KVIZ_TABLO_ADI);

 
 /* GENEL BİLGİLER */
 WMUST_NO       = COM_MUST_NO;
 WSLAVE_MUST_NO = COM_SLAVE_MUST_NO;
 COM_KVIZ_HATA  = 0;
    
 IF COM_SLAVE_MUST_NO > 0
    THEN WPERS_MUST_NO = WSLAVE_MUST_NO; /* slave  */
    ELSE WPERS_MUST_NO = WMUST_NO;       /* master */
    
 IF COM_OZL_KULL_KOD ^= ' ' THEN DO;     
    CALL SEL_INTRNT_CCR_PRVT_USER_RL;
    WSLAVE_MUST_NO = WMUST_NO_OZL;
    WPERS_MUST_NO  = WMUST_NO_OZL;      /* slave=özel kullanıcı */
 END;
   
 IF WSLAVE_MUST_NO > 0
    THEN WPERS_MUST_NO = WSLAVE_MUST_NO;
    ELSE WPERS_MUST_NO = WMUST_NO;

 CALL MIN_MAX_VADE_BUL;
 CALL MIY_SICIL_BUL;
 CALL MIY_BILGILERI_BUL;
 CALL MIY_DUYURU_BUL;
 CALL DVZ_KUR_OKU;
 CALL ISTENEN_DVZ_STS_BUL;
 CALL INIT_INTRNT_COM_AREA_ATAMA;
 CALL KISISEL_BILGILERI_BUL;
 CALL MIY_SOZLESME_BUL;
 /* -------------------------------------------------  6.11.2003
 IF KISISEL_FLAG = 'H' ! Y_FLAG = 'E' THEN CALL PIYASA_BILGILERI;
 ------------------------------------------------------------- */

 IF WSLAVE_MUST_NO > 0 THEN DO;
    IF KISISEL_FLAG = 'H' ! Y_FLAG = 'E' THEN CALL PIYASA_BILGILERI;
 END;
 ELSE DO;
    IF KISISEL_FLAG = 'H' ! Y_FLAG = 'E' THEN DO;
       EXEC SQL SELECT COUNT(*)
                  INTO :WKISISEL_ADET
                  FROM MARKET_PERS_INFO
                 WHERE MUST_NO = :WPERS_MUST_NO
                 WITH  UR;
       IF SQLCODE ^= 0 & SQLCODE ^= 100 THEN DO;
          COM_PIYASA_RC = 10;
          SQLCODE_PIC = SQLCODE;
          COM_PIYA_HATA_ACK = 'MARKET_PERS_INFO-HATA' !! SQLCODE_PIC;
       END;
       ELSE DO;
          IF SQLCODE = 0 THEN DO;
             IF WKISISEL_ADET = 0 THEN DO;/* ADET=0 İSE ESKİ ŞEKİLDE */
                COM_USD_EUR_PAR = 0;
                CALL PIYASA_BILGILERI;
              END;
              ELSE DO;
                CALL LINK_KSSL004;
             END;
          END;
          ELSE DO;
             COM_USD_EUR_PAR = 0;
             CALL PIYASA_BILGILERI;
          END;
       END;
    END; /* KİŞİSELLEŞTIRME KUTUSU İSTENMİŞ İSE */
 END; /* MASTER MÜŞTERİ */

 IF KISISEL_FLAG = 'H' ! J_FLAG = 'E' THEN CALL AJANDA_BILGILERI;

 COM_PYS_KOLON_NO = Y_KOLON;  COM_PYS_SIRA_NO = Y_SIRA;
 COM_AJN_KOLON_NO = J_KOLON;  COM_AJN_SIRA_NO = J_SIRA;

 /* -------------------- "25+O" KREDİ ÖDEMESİ -------------------- */
 IF COM_CALISMA_KOD(25) = 'E' !
   (COM_CALISMA_KOD(25) = 'K' & KISISEL_FLAG = 'H') !
   (COM_CALISMA_KOD(25) = 'K' & O_FLAG       = 'E') THEN
 CALL LINK_KVAD002;

 /* ------------------ "26+O" KREDİ KART ÖDEMESİ-TL --------------- */
 /* ------------------ "55+O" KREDİ KART ÖDEMESİ-YP --------------- */
 IF COM_CALISMA_KOD(26) = 'E' !
   (COM_CALISMA_KOD(26) = 'K' & KISISEL_FLAG = 'H') !
   (COM_CALISMA_KOD(26) = 'K' & O_FLAG       = 'E') THEN
 CALL LINK_KVKK001;

 /* ---------------- "11..14+K" KREDİ BİLGİLERİ ------------------- */
 IF COM_CALISMA_KOD(11) = 'E' !
   (COM_CALISMA_KOD(11) = 'K' & KISISEL_FLAG = 'H') !
   (COM_CALISMA_KOD(11) = 'K' & K_FLAG       = 'E') THEN
 CALL LINK_KVKT001;
 /* ------------------------ "22+O" EFT --------------------------- */
 IF COM_CALISMA_KOD(22) = 'E' !
   (COM_CALISMA_KOD(22) = 'K' & KISISEL_FLAG = 'H') !
   (COM_CALISMA_KOD(22) = 'K' & O_FLAG       = 'E') THEN
 CALL LINK_EF2P008;

 /* -------------------- "23+O" HAVALE (TL)  ---------------------- */
 /* -------------------- "24+O" HAVALE (YP)  ---------------------- */
 IF COM_CALISMA_KOD(23) = 'E' !
   (COM_CALISMA_KOD(23) = 'K' & KISISEL_FLAG = 'H') !
   (COM_CALISMA_KOD(23) = 'K' & O_FLAG       = 'E') THEN
 CALL LINK_KMSL001;

 /* ------------------- "31+O" OTOMATİK ÖDEME -------------------- */
 IF COM_CALISMA_KOD(31) = 'E' !
   (COM_CALISMA_KOD(31) = 'K' & KISISEL_FLAG = 'H') !
   (COM_CALISMA_KOD(31) = 'K' & O_FLAG       = 'E') THEN
 CALL LINK_FATI006;

 /* ----------------- "30+O" FATURA ÖDEMESİ (DBS) ---------------- */
 IF COM_CALISMA_KOD(30) = 'E' !
   (COM_CALISMA_KOD(30) = 'K' & KISISEL_FLAG = 'H') !
   (COM_CALISMA_KOD(30) = 'K' & O_FLAG       = 'E') THEN
 CALL LINK_FATI007;

 /* ---------------- "38+T" FATURA TAHSİLATI (DBS) ---------------- */
 /* ---------------- "21+D" FATURALAR (DBS)        ---------------- */
 CALL LINK_FATI008;

 /* ------------------ "27+O" KOMİSYON ÖDEMESİ -------------------- */
 IF COM_CALISMA_KOD(27) = 'E' !
   (COM_CALISMA_KOD(27) = 'K' & KISISEL_FLAG = 'H') !
   (COM_CALISMA_KOD(27) = 'K' & O_FLAG       = 'E') THEN
 CALL LINK_KVTM001;

 /* ---------------- "1..10+V" VADELİ HESAPLAR   ------------------ */
 /* ---------------- "1..10+Z" VADESİZ HESAPLAR  ------------------ */
 /* ---------------- "1..10+Y" YATIRIM HESAPLARI ------------------ */
 IF COM_CALISMA_KOD(01) = 'E' !
   (COM_CALISMA_KOD(01) = 'K' & KISISEL_FLAG = 'H') !
   (COM_CALISMA_KOD(01) = 'K' & H_FLAG       = 'E') THEN
 CALL LINK_INTC110;

 /* -------------------- "15+I" AKREDİTİFLER ---------------------- */
 /* -------------------- "16+I" POLİÇELER    ---------------------- */
 IF COM_CALISMA_KOD(15) = 'E' !
   (COM_CALISMA_KOD(15) = 'K' & KISISEL_FLAG = 'H') !
   (COM_CALISMA_KOD(15) = 'K' & I_FLAG       = 'E') THEN
 CALL LINK_ITHI001;

 /* ------------------- "33+O" POLİÇE ÖDEMESİ    ------------------ */
 /* ------------------- "34+O" AKREDİTİF ÖDEMESİ ------------------ */
 IF COM_CALISMA_KOD(33) = 'E' !
   (COM_CALISMA_KOD(33) = 'K' & KISISEL_FLAG = 'H') !
   (COM_CALISMA_KOD(33) = 'K' & O_FLAG       = 'E') THEN
 CALL LINK_ITHI002;

 /* --------------------- "17+D" ÇEK DEPOSU TL -------------------- */
 /* --------------------- "18+D" ÇEK DEPOSU YP -------------------- */
 IF COM_CALISMA_KOD(17) = 'E' !
   (COM_CALISMA_KOD(17) = 'K' & KISISEL_FLAG = 'H') !
   (COM_CALISMA_KOD(17) = 'K' & D_FLAG       = 'E') THEN
 CALL LINK_CEKC100;

 /* ------------------- "19+D" SENET DEPOSU TL -------------------- */
 /* ------------------- "20+D" SENET DEPOSU YP -------------------- */
 IF COM_CALISMA_KOD(19) = 'E' !
   (COM_CALISMA_KOD(19) = 'K' & KISISEL_FLAG = 'H') !
   (COM_CALISMA_KOD(19) = 'K' & D_FLAG       = 'E') THEN
 CALL LINK_SNET001;

 /* --------------------- "28+O" ÇEK ÖDEMESİ TL ------------------- */
 /* --------------------- "29+O" ÇEK ÖDEMESİ YP ------------------- */
 IF COM_CALISMA_KOD(28) = 'E' !
   (COM_CALISMA_KOD(28) = 'K' & KISISEL_FLAG = 'H') !
   (COM_CALISMA_KOD(28) = 'K' & O_FLAG       = 'E') THEN
 CALL LINK_CEKC101;

 /* ------------------- "35+T" ÇEK TAHSİLATI TL ------------------- */
 /* ------------------- "36+T" ÇEK TAHSİLATI YP ------------------- */
 IF COM_CALISMA_KOD(35) = 'E' !
   (COM_CALISMA_KOD(35) = 'K' & KISISEL_FLAG = 'H') !
   (COM_CALISMA_KOD(35) = 'K' & T_FLAG       = 'E') THEN
 CALL LINK_CEKC104;

 /* ------------------- "37+T" SENET TAHSİLATI(TL) ---------------- */
 /* ------------------- "44+T" SENET TAHSİLATI(YP) ---------------- */
 IF COM_CALISMA_KOD(37) = 'E' !
   (COM_CALISMA_KOD(37) = 'K' & KISISEL_FLAG = 'H') !
   (COM_CALISMA_KOD(37) = 'K' & T_FLAG       = 'E') THEN
 CALL LINK_SNET002;

 /* ------------------- "39+M" VADELİ (TL) ------------------------ */
 /* ------------------- "40+M" VADELİ (YP) ------------------------ */
 IF COM_CALISMA_KOD(39) = 'E' !
   (COM_CALISMA_KOD(39) = 'K' & KISISEL_FLAG = 'H') !
   (COM_CALISMA_KOD(39) = 'K' & M_FLAG       = 'E') THEN
 CALL LINK_VDLC001;

 /* ------------------- "41+M" REPOLAR         -------------------- */
 /* ------------------- "42+M" HAZİNE BONOLARI -------------------- */
 IF COM_CALISMA_KOD(41) = 'E' !
   (COM_CALISMA_KOD(41) = 'K' & KISISEL_FLAG = 'H') !
   (COM_CALISMA_KOD(41) = 'K' & M_FLAG       = 'E') THEN
 CALL LINK_MKL540;

 /* --------------- "43+O" TİCARİ DESTEK KREDİLERİ ---------------- */
 /* --------------- "45+O" TİCARİ DESTEK KREDİLERİ ---------------- */
 IF COM_CALISMA_KOD(43) = 'E' !
   (COM_CALISMA_KOD(43) = 'K' & KISISEL_FLAG = 'H') !
   (COM_CALISMA_KOD(43) = 'K' & O_FLAG       = 'E') THEN
 CALL LINK_BKHI001;

 /* -------------------- "32+O" MAAŞ ÖDEMESİ -------------------- */
 IF COM_CALISMA_KOD(32) = 'E' !
   (COM_CALISMA_KOD(32) = 'K' & KISISEL_FLAG = 'H') !
   (COM_CALISMA_KOD(32) = 'K' & O_FLAG       = 'E') THEN
 CALL LINK_BORC002;

 /* ---------------- "46  " HESAPLAR TOPLAMI (TL)        --------- */
 /* ---------------- "47  " HESAPLAR TOPLAMI (YP)        --------- */
 /* ---------------- "48  " KREDİ BİLGİLERİ TOPLAMI (TL) --------- */
 /* ---------------- "49  " KREDİ BİLGİLERİ TOPLAMI (YP) --------- */
 /* ---------------- "50  " DEPO TOPLAMI (TL)            --------- */
 /* ---------------- "51  " DEPO TOPLAMI (YP)            --------- */
 CALL TOPLAM_KRITERLERI_HESAPLA;

 EXEC CICS RETURN;

 MIN_MAX_VADE_BUL:PROC;
    EXEC SQL SELECT CURRENT DATE, CURRENT DATE+1 DAYS,
                                  CURRENT DATE+2 DAYS
               INTO :WDATE1, :WDATE2, :WDATE3
               FROM TXN_EV
               WITH UR;
    IF SQLCODE ^= 0 THEN DO;
       COM_KVIZ_HATA      = SQLCODE;
       COM_KVIZ_TABLO_ADI = 'TXN_EV';
       EXEC CICS RETURN;
    END;

    EXEC SQL DECLARE PRYT_CSR CURSOR FOR
             SELECT  SUBSTR(BILGI_DETAY,1,1)
             FROM    INTRNT_PERS_INFO
             WHERE   MUST_NO IN (0, :WPERS_MUST_NO) AND
                     BILGI_KOD = 'P'
         ORDER BY    MUST_NO DESC WITH UR;

    EXEC SQL OPEN PRYT_CSR;
    IF SQLCODE ^= 0 THEN DO;
       COM_KVIZ_HATA      = SQLCODE;
       COM_KVIZ_TABLO_ADI = 'INTRNT_PERS_INFO-6';
       EXEC CICS RETURN;
    END;

    EXEC SQL FETCH PRYT_CSR INTO :WPERIYOT;
    IF SQLCODE  = 100 THEN WPERIYOT = '1';
    ELSE IF SQLCODE ^= 0 THEN DO;
       COM_KVIZ_HATA      = SQLCODE;
       COM_KVIZ_TABLO_ADI = 'INTRNT_PERS_INFO-7';
       EXEC CICS RETURN;
    END;

    EXEC SQL CLOSE PRYT_CSR;
    IF SQLCODE ^= 0 THEN DO;
       COM_KVIZ_HATA      = SQLCODE;
       COM_KVIZ_TABLO_ADI = 'INTRNT_PERS_INFO-8';
       EXEC CICS RETURN;
    END;

    COM_PERIYOT = WPERIYOT;
    WMIN_VADE   = WDATE1;

    SELECT (WPERIYOT);
       WHEN('1') WMAX_VADE = WDATE1;
       WHEN('2') WMAX_VADE = WDATE2;
       WHEN('3') WMAX_VADE = WDATE3;
       OTHERWISE WMAX_VADE = WDATE1;
    END;
 END MIN_MAX_VADE_BUL;

 MIY_SICIL_BUL:PROC;
    FMUST_NO = COM_MUST_NO;
    WMUST_NO = FMUST_NO;

    EXEC SQL SELECT  SICIL_NO
               INTO  :WSICIL_NO
               FROM  PMK_CSTMR
               WHERE MUST_NO = :WMUST_NO
               WITH UR;
    IF SQLCODE ^= 0 THEN DO;
       COM_KVIZ_HATA      = SQLCODE;
       COM_KVIZ_TABLO_ADI = 'PMK_CSTMR';
       EXEC CICS RETURN;
    END;
 END MIY_SICIL_BUL;

 MIY_BILGILERI_BUL:PROC;
    WPERS_AD, WPERS_SOYAD, WCEP_TEL_NO, WIS_TEL = ' ';
    WRESIM_FLAG, WINTERNET_ID = ' ';

    IF WSICIL_NO ^= '     ' & WSICIL_NO ^= '00000' THEN DO;
       EXEC SQL SELECT PERS_AD, PERS_SOYAD, CEP_TEL_NO,
                       IS_TEL, RESIM_FLAG, INTERNET_ID
                  INTO :WPERS_AD, :WPERS_SOYAD, :WCEP_TEL_NO,
                       :WIS_TEL, :WRESIM_FLAG, :WINTERNET_ID
                  FROM  PMK_EMPLOYEE
                  WHERE SICIL_NO = :WSICIL_NO
                  WITH UR;
       IF SQLCODE = 100 THEN DO;
          WPERS_AD, WPERS_SOYAD, WCEP_TEL_NO, WIS_TEL = ' ';
          WRESIM_FLAG, WINTERNET_ID = ' ';
       END;
       ELSE IF SQLCODE ^= 0 THEN DO;
          COM_KVIZ_HATA   = SQLCODE;
          COM_KVIZ_TABLO_ADI = 'PMK_EMPLOYEE';
          EXEC CICS RETURN;
       END;
    END;
 END MIY_BILGILERI_BUL;

 MIY_DUYURU_BUL:PROC;
    WMESAJ_TNM = ' ';
    EXEC SQL DECLARE MSG_CSR CURSOR FOR
             SELECT  MESAJ_TNM
             FROM    RM_MESSAGE
             WHERE   SICIL_NO       = :WSICIL_NO     AND
                     GCRLK_BAS_TAR <= CURRENT DATE   AND
                     GCRLK_BIT_TAR >= CURRENT DATE   AND
                     IPTAL_TAR_ZMN  = '1900-01-01-00.00.00.000000' AND
                     MUST_NO       IN (0, :WMUST_NO)
            ORDER BY MUST_NO DESC
            WITH UR;

    EXEC SQL OPEN MSG_CSR;
    IF SQLCODE ^= 0 THEN DO;
       COM_KVIZ_HATA      = SQLCODE;
       COM_KVIZ_TABLO_ADI = 'RM_MESSAGE-1';
       EXEC CICS RETURN;
    END;

    EXEC SQL FETCH MSG_CSR INTO :WMESAJ_TNM;
    IF SQLCODE = 100 THEN WMESAJ_TNM = ' ';
       ELSE IF SQLCODE ^= 0 THEN DO;
          COM_KVIZ_HATA      = SQLCODE;
          COM_KVIZ_TABLO_ADI = 'RM_MESSAGE-2';
          EXEC CICS RETURN;
       END;

    EXEC SQL CLOSE MSG_CSR;
    IF SQLCODE ^= 0 THEN DO;
       COM_KVIZ_HATA      = SQLCODE;
       COM_KVIZ_TABLO_ADI = 'RM_MESSAGE-3';
       EXEC CICS RETURN;
    END;
 END MIY_DUYURU_BUL;

 KISISEL_BILGILERI_BUL:PROC;
 /* ----------------------------
    P : PERİYOT BİLGİSİ
    H : HESAP BİLGİLERİ
    K : KREDİ BİLGİLERİ
    I : İTHALAT İŞLEMLERİ
    D : DEPO BİLGİLERİ
    O : VADESİ GELEN ÖDEMELER
    T : TAHSİLAT BİLGİLERİ
    M : TAHSİLİ BEKLENEN KIYMETLER
    J : AJANDA BİLGİLERİ
    Y : PİYASA BİLGİLERİ
    ---------------------------- */

    KISISEL_FLAG = 'H';
    H_FLAG, K_FLAG, I_FLAG, D_FLAG, O_FLAG, T_FLAG, M_FLAG = 'H';
    J_FLAG, Y_FLAG  = 'H';

    EXEC SQL SELECT  COUNT(*)
               INTO  :WCOUNT
               FROM  INTRNT_PERS_INFO
               WHERE MUST_NO = :WPERS_MUST_NO AND
                     BILGI_KOD IN ('H','K','I','D','O','T','M','J','Y')
               WITH UR;
    IF SQLCODE = 0 THEN KISISEL_FLAG = 'E';
       ELSE IF SQLCODE = -305 ! SQLCODE = 100 THEN KISISEL_FLAG = 'H';
       ELSE IF SQLCODE ^= 0 THEN DO;
          COM_KVIZ_HATA      = SQLCODE;
          COM_KVIZ_TABLO_ADI = 'INTRNT_PERS_INFO-0';
          EXEC CICS RETURN;
       END;

    IF WCOUNT = 0 THEN KISISEL_FLAG = 'H';

    IF KISISEL_FLAG = 'E' THEN DO;

       EXEC SQL DECLARE PERS_CSR CURSOR FOR
                SELECT  BILGI_KOD, SUTUN_NO, SATIR_NO
                FROM    INTRNT_PERS_INFO
                WHERE   MUST_NO = :WPERS_MUST_NO AND
                        BILGI_KOD IN
                        ('H','K','I','D','O','T','M','J','Y')
                WITH UR;

       EXEC SQL OPEN PERS_CSR;
       IF SQLCODE ^= 0 THEN DO;
          COM_KVIZ_HATA      = SQLCODE;
          COM_KVIZ_TABLO_ADI = 'INTRNT_PERS_INFO-1';
          EXEC CICS RETURN;
       END;

       EXEC SQL FETCH PERS_CSR INTO
                      :WBILGI_KOD, :WSUTUN_NO, :WSATIR_NO;
       IF SQLCODE ^= 0 & SQLCODE ^= 100 THEN DO;
          COM_KVIZ_HATA      = SQLCODE;
          COM_KVIZ_TABLO_ADI = 'INTRNT_PERS_INFO-2';
          EXEC CICS RETURN;
       END;

       DO WHILE (SQLCODE = 0);

          SELECT (WBILGI_KOD);
             WHEN ('H') DO;
                  H_FLAG='E'; H_KOLON=WSUTUN_NO; H_SIRA=WSATIR_NO; END;
             WHEN ('K') DO;
                  K_FLAG='E'; K_KOLON=WSUTUN_NO; K_SIRA=WSATIR_NO; END;
             WHEN ('I') DO;
                  I_FLAG='E'; I_KOLON=WSUTUN_NO; I_SIRA=WSATIR_NO; END;
             WHEN ('D') DO;
                  D_FLAG='E'; D_KOLON=WSUTUN_NO; D_SIRA=WSATIR_NO; END;
             WHEN ('O') DO;
                  O_FLAG='E'; O_KOLON=WSUTUN_NO; O_SIRA=WSATIR_NO; END;
             WHEN ('T') DO;
                  T_FLAG='E'; T_KOLON=WSUTUN_NO; T_SIRA=WSATIR_NO; END;
             WHEN ('M') DO;
                  M_FLAG='E'; M_KOLON=WSUTUN_NO; M_SIRA=WSATIR_NO; END;
             WHEN ('J') DO;
                  J_FLAG='E'; J_KOLON=WSUTUN_NO; J_SIRA=WSATIR_NO; END;
             WHEN ('Y') DO;
                  Y_FLAG='E'; Y_KOLON=WSUTUN_NO; Y_SIRA=WSATIR_NO; END;
             OTHERWISE;
          END;

          EXEC SQL FETCH PERS_CSR INTO
                         :WBILGI_KOD, :WSUTUN_NO, :WSATIR_NO;
          IF SQLCODE ^= 0 & SQLCODE ^= 100 THEN DO;
             COM_KVIZ_HATA      = SQLCODE;
             COM_KVIZ_TABLO_ADI = 'INTRNT_PERS_INFO-3';
             EXEC CICS RETURN;
          END;
       END; /* WHILE SQLCODE = 0 */

       EXEC SQL CLOSE PERS_CSR;
       IF SQLCODE ^= 0 THEN DO;
          COM_KVIZ_HATA      = SQLCODE;
          COM_KVIZ_TABLO_ADI = 'INTRNT_PERS_INFO-4';
          EXEC CICS RETURN;
       END;
    END; /* IF KISISEL_FLAG = 'E' THEN */

 END KISISEL_BILGILERI_BUL;

 MIY_SOZLESME_BUL:PROC;
    SOZLESME_FLAG = 'H';
    EXEC SQL SELECT  BILGI_DETAY
               INTO  :WBILGI_DETAY
               FROM  INTRNT_PERS_INFO
               WHERE MUST_NO   = :WPERS_MUST_NO AND
                     BILGI_KOD = 'S'
               WITH UR;
    IF SQLCODE = 0 THEN SOZLESME_FLAG = 'E';
       ELSE IF SQLCODE = 100 THEN SOZLESME_FLAG = 'H';
       ELSE IF SQLCODE ^= 0 THEN DO;
          COM_KVIZ_HATA      = SQLCODE;
          COM_KVIZ_TABLO_ADI = 'INTRNT_PERS_INFO-5';
          EXEC CICS RETURN;
       END;
    COM_SOZLESME = SOZLESME_FLAG;
 END MIY_SOZLESME_BUL;

 DVZ_KUR_OKU:PROC;
    EXEC SQL DECLARE CURR_CSR CURSOR FOR
             SELECT  T2.DVZ_KOD, T2.DVZ_TIP, T1.DVZ_SATIS, T1.DVZ_ALIS
             FROM    DAILY_CURR_RATE T1, CURR T2
             WHERE   T1.DVZ_KOD = T2.DVZ_KOD AND
                     KUR_TIP_KOD = 'I'       AND
                     T2.DVZ_KOD > 9000
            ORDER BY T2.DVZ_KOD
            WITH UR;

    EXEC SQL OPEN CURR_CSR;
    IF SQLCODE ^= 0 THEN DO;
       COM_KVIZ_HATA      = SQLCODE;
       COM_KVIZ_TABLO_ADI = 'CURR-1';
       EXEC CICS RETURN;
    END;

    EXEC SQL FETCH CURR_CSR INTO
                   :WDVZ_KOD, :WDVZ_TIP, :WDVZ_SATIS, :WDVZ_ALIS;
    IF SQLCODE ^= 0 THEN DO;
       COM_KVIZ_HATA      = SQLCODE;
       COM_KVIZ_TABLO_ADI = 'CURR-2';
       EXEC CICS RETURN;
    END;

    DO WHILE (SQLCODE = 0);
       LL = LL + 1;
       DVZ_KOD_ARR(LL) = WDVZ_KOD;
       DVZ_TIP_ARR(LL) = WDVZ_TIP;

       IF WDVZ_KOD = 9170
          THEN DO;
             DVZ_STS_ARR(LL) = WDVZ_SATIS/100;
             DVZ_ALS_ARR(LL) = WDVZ_ALIS/100;
          END;
          ELSE DO;
             DVZ_STS_ARR(LL) = WDVZ_SATIS;
             DVZ_ALS_ARR(LL) = WDVZ_ALIS;
          END;

       EXEC SQL FETCH CURR_CSR INTO
                      :WDVZ_KOD, :WDVZ_TIP, :WDVZ_SATIS, :WDVZ_ALIS;
       IF SQLCODE ^= 0 & SQLCODE ^= 100 THEN DO;
          COM_KVIZ_HATA      = SQLCODE;
          COM_KVIZ_TABLO_ADI = 'CURR-3';
          EXEC CICS RETURN;
       END;
    END;

    EXEC SQL CLOSE CURR_CSR;
    IF SQLCODE ^= 0 THEN DO;
       COM_KVIZ_HATA      = SQLCODE;
       COM_KVIZ_TABLO_ADI = 'CURR-4';
       EXEC CICS RETURN;
    END;
 END DVZ_KUR_OKU;

 COM_DIGER_INITIALIZE:PROC;
    DCOM_MUST_NO       = COM_MUST_NO;
    DCOM_MINVADE       = WMIN_VADE;
    DCOM_MAXVADE       = WMAX_VADE;
    DCOM_SLAVE_MUST_NO = COM_SLAVE_MUST_NO;
    DCOM_FILLER        = '';

    DCOM_RC       (*)  = 0;
    DCOM_TABLO_ADI(*)  = '';
    DCOM_KRITER_NO(*)  = 0;
    DCOM_GRUP_KOD (*)  = ' ';
    DCOM_DVZ_KOD  (*)  = 0;
    DCOM_TUTAR    (*)  = 0;
    DCOM_ADET     (*)  = 0;
 END COM_DIGER_INITIALIZE;

 INIT_INTRNT_COM_AREA_ATAMA:PROC;
    COM_MINVADE         = WMIN_VADE;
    COM_MAXVADE         = WMAX_VADE;
    COM_MIY_AD          = WPERS_AD;
    COM_MIY_SOYAD       = WPERS_SOYAD;
    COM_MIY_SICIL       = WSICIL_NO;
    COM_MIY_CEPTEL      = WCEP_TEL_NO;
    COM_MIY_ISTEL       = WIS_TEL;
    COM_MIY_MAIL        = WINTERNET_ID;
    COM_MIY_DUYURU      = WMESAJ_TNM;
    COM_MIY_FOTO        = WRESIM_FLAG;

    COM_RC          (*) = 0;
    COM_TABLO_ADI   (*) = ' ';
    COM_KOLON_NO    (*) = 0;
    COM_SIRA_NO     (*) = 0;
    COM_GRUP_KOD    (*) = ' ';
    COM_DVZ_TIP     (*) = ' ';
    COM_TUTAR       (*) = 0;
    COM_ADET        (*) = 0;

    DO I = 1 TO 60;
       COM_KRITER_NO(I) = I;
    END;

 END INIT_INTRNT_COM_AREA_ATAMA;

 INTRNT_COM_AREA_ATAMA:PROC;
    II = 1;
    DO WHILE (DCOM_KRITER_NO(II) > 0);

       ESKI_KRITER_NO = DCOM_KRITER_NO(II);
       ESKI_GRUP_KOD  = DCOM_GRUP_KOD (II);
       TL_TUTAR  = 0; TL_ADET        = 0;
       YP_TUTAR  = 0; YP_ADET        = 0;
       TL_BULDUM = 0; YP_BULDUM      = 0;
       TEMP_RC   = 0; TEMP_TABLO_ADI = '';

       DO WHILE ( ESKI_KRITER_NO = DCOM_KRITER_NO(II) &
                                   DCOM_KRITER_NO(II) > 0 );
          IF DCOM_RC(II) ^= 0 THEN DO;
             TEMP_RC          = DCOM_RC(II);
             TEMP_TABLO_ADI   = DCOM_TABLO_ADI(II);
             CALL COM_ATAMA_ORTAK;
             COM_DVZ_TIP(NDX) = '   ';
             COM_TUTAR  (NDX) = 0;
             COM_ADET   (NDX) = 0;
          END;
          ELSE DO;
             IF DCOM_DVZ_KOD(II) = 9000 ! DCOM_DVZ_KOD(II) = 0 THEN DO;
                TL_BULDUM = 1;
                TL_TUTAR = DCOM_TUTAR(II);
                TL_ADET  = DCOM_ADET (II);
             END;
             ELSE DO;
                YP_BULDUM = 1;
                CALL PARITE_BUL;
      (NOFOFL): YP_TUTAR = YP_TUTAR + PARITE_KARSILIK;
                YP_ADET  = YP_ADET  + DCOM_ADET(II);
             END;
          END;
          II = II + 1;
       END;

       IF TL_BULDUM = 1 THEN DO;
          CALL COM_ATAMA_ORTAK;
          COM_DVZ_TIP(NDX) = 'TL ';
          COM_TUTAR  (NDX) = TL_TUTAR;
          COM_ADET   (NDX) = TL_ADET;
       END;
       IF YP_BULDUM = 1 THEN DO;
          CALL COM_ATAMA_ORTAK;
          COM_DVZ_TIP(NDX) = ISTENEN_DVZ_TIP;
          COM_TUTAR  (NDX) = YP_TUTAR;
          COM_ADET   (NDX) = YP_ADET;
       END;

    END;
 END INTRNT_COM_AREA_ATAMA;

 INTRNT_COM_AREA_ATAMA_INTC:PROC;
    II = 1;
    DO WHILE (DCOM_KRITER_NO(II) > 0 & II < 11 );

       NDX                 = DCOM_KRITER_NO  (II);
       COM_KRITER_NO (NDX) = DCOM_KRITER_NO  (II);
       COM_GRUP_KOD  (NDX) = DCOM_GRUP_KOD   (II);
       COM_RC        (NDX) = DCOM_RC         (II);
       COM_TABLO_ADI (NDX) = DCOM_TABLO_ADI  (II);
       COM_TUTAR     (NDX) = DCOM_TUTAR      (II);
       COM_ADET      (NDX) = DCOM_ADET       (II);
      /* IF DCOM_DVZ_KOD(II) = 9000 THEN COM_DVZ_TIP (NDX) = 'YTL'; */
       IF DCOM_DVZ_KOD(II) = 9000 THEN COM_DVZ_TIP (NDX) = 'TL ';
       ELSE DO;
          DO I = 1 TO 80 ;
             IF DCOM_DVZ_KOD(II) = DVZ_KOD_ARR(I) THEN
                DO;
                   COM_DVZ_TIP (NDX) = DVZ_TIP_ARR (I);
                   LEAVE;
                END;
          END;
       END;
       II = II + 1;
    END;
 END INTRNT_COM_AREA_ATAMA_INTC;

 COM_ATAMA_ORTAK:PROC;
    NDX                  = ESKI_KRITER_NO;
    IF NDX <= 0 ! NDX > 60 THEN NDX = 60;
    COM_KRITER_NO  (NDX) = ESKI_KRITER_NO;
    COM_GRUP_KOD   (NDX) = ESKI_GRUP_KOD;
    COM_RC         (NDX) = TEMP_RC;
    COM_TABLO_ADI  (NDX) = TEMP_TABLO_ADI;
 END COM_ATAMA_ORTAK;

 ISTENEN_DVZ_STS_BUL:PROC;
    DO I = 1 TO 80 ;
       IF ISTENEN_DVZ_KOD = DVZ_KOD_ARR(I) THEN
          DO;
             ISTENEN_DVZ_STS = DVZ_STS_ARR(I);
             ISTENEN_DVZ_ALS = DVZ_ALS_ARR(I);
             LEAVE;
          END;
       END;
 END ISTENEN_DVZ_STS_BUL;

 PARITE_BUL:PROC;
    IF DCOM_DVZ_KOD(II) = 9000
       THEN ISL_KUR = 1.0000;
       ELSE DO;
          DO I = 1 TO 80 ;
             IF DCOM_DVZ_KOD(II) = DVZ_KOD_ARR(I) THEN
                DO;
                   ISL_KUR = DVZ_ALS_ARR(I);
                   LEAVE;
                END;
          END;
       END;
    PARITE = 1;
    IF ISL_KUR > 0 THEN
       DO;
          IF DCOM_DVZ_KOD(II) = ISTENEN_DVZ_KOD
             THEN PARITE = 1;
             ELSE PARITE = DIVIDE(ISTENEN_DVZ_ALS,ISL_KUR,15,8);
       END;
    PARITE_KARSILIK = DIVIDE (DCOM_TUTAR (II), PARITE, 17, 2);
 END PARITE_BUL;

 PARITE_BUL_2:PROC;
 /* IF COM_DVZ_TIP(II) = 'YTL'                8.8.2005 F.B.       */

    ISL_KUR = ISTENEN_DVZ_ALS;

    IF COM_DVZ_TIP(II) = 'YTL' ! COM_DVZ_TIP(II) = '   ' !
       COM_DVZ_TIP(II) = 'TRL' ! COM_DVZ_TIP(II) = ''    !
       COM_DVZ_TIP(II) = 'TL '
       THEN ISL_KUR = 1;
       ELSE DO;
          DO I = 1 TO 80 ;
             IF COM_DVZ_TIP(II) = DVZ_TIP_ARR(I) THEN DO;
                ISL_KUR = DVZ_ALS_ARR(I);
                LEAVE;
             END;
          END;
       END;
    PARITE = 1;
    IF ISL_KUR > 0 THEN DO;
       IF COM_DVZ_TIP(II) = ISTENEN_DVZ_TIP
          THEN PARITE = 1;
          ELSE PARITE = DIVIDE ( ISTENEN_DVZ_ALS, ISL_KUR, 15, 8 );
    END;
    IF PARITE > 0
    /* THEN PARITE_KARSILIK = DIVIDE (COM_TUTAR (II), PARITE, 17, 2) */
       THEN PARITE_KARSILIK = COM_TUTAR (II) / PARITE;
       ELSE PARITE_KARSILIK = 0;
 END PARITE_BUL_2;

 LINK_FATI006:PROC;
    CALL COM_DIGER_INITIALIZE;

    COM_PRG_AD = 'FATI006';
    EXEC CICS LINK PROGRAM('FATI006') COMMAREA(COM_DIGER)
                                      RESP(RESP_CODE) NOHANDLE ;
    IF RESP_CODE ^= 0 THEN COM_KVIZ_HATA = 1;

    CALL INTRNT_COM_AREA_ATAMA;

    COM_KOLON_NO(31) = O_KOLON;  COM_SIRA_NO(31) = O_SIRA;

 END LINK_FATI006;

 LINK_FATI007:PROC;
    CALL COM_DIGER_INITIALIZE;

    COM_PRG_AD = 'FATI007';
    EXEC CICS LINK PROGRAM('FATI007') COMMAREA(COM_DIGER)
                                      RESP(RESP_CODE) NOHANDLE ;
    IF RESP_CODE ^= 0 THEN COM_KVIZ_HATA = 2;

    CALL INTRNT_COM_AREA_ATAMA;

    COM_KOLON_NO(30) = O_KOLON;  COM_SIRA_NO(30) = O_SIRA;

 END LINK_FATI007;

 LINK_FATI008:PROC;
    CALL COM_DIGER_INITIALIZE;

    COM_PRG_AD = 'FATI008';
    EXEC CICS LINK PROGRAM('FATI008') COMMAREA(COM_DIGER)
                                      RESP(RESP_CODE) NOHANDLE ;
    IF RESP_CODE ^= 0 THEN COM_KVIZ_HATA = 3;

    CALL INTRNT_COM_AREA_ATAMA;

    COM_KOLON_NO(38) = T_KOLON;  COM_SIRA_NO(38) = T_SIRA;
    COM_KOLON_NO(21) = D_KOLON;  COM_SIRA_NO(21) = D_SIRA;

 END LINK_FATI008;

 LINK_KVAD002:PROC;
    CALL COM_DIGER_INITIALIZE;

    COM_PRG_AD = 'KVAD002';
    EXEC CICS LINK PROGRAM('KVAD002') COMMAREA(COM_DIGER)
                                      RESP(RESP_CODE) NOHANDLE ;
    IF RESP_CODE ^= 0 THEN COM_KVIZ_HATA = 4;

    CALL INTRNT_COM_AREA_ATAMA;

    COM_KOLON_NO(25) = O_KOLON;  COM_SIRA_NO(25) = O_SIRA;

 END LINK_KVAD002;

 LINK_INTC110:PROC;
    CALL COM_DIGER_INITIALIZE;

    COM_PRG_AD = 'INTC110';
    EXEC CICS LINK PROGRAM('INTC110') COMMAREA(COM_DIGER)
                                      RESP(RESP_CODE) NOHANDLE ;
    IF RESP_CODE ^= 0 THEN COM_KVIZ_HATA = 5;

    CALL INTRNT_COM_AREA_ATAMA_INTC;

    DO I = 1 TO 10;
       COM_KOLON_NO(I) = H_KOLON;  COM_SIRA_NO(I) = H_SIRA;
    END;

 END LINK_INTC110;

 LINK_KVKT001:PROC;
    EXEC CICS ENTER TRACEID(1) FROM(COM_MUST_NO);
    CALL COM_DIGER_INITIALIZE;
    EXEC CICS ENTER TRACEID(2) FROM(COM_MUST_NO);
    COM_PRG_AD = 'KVKT001';
    EXEC CICS LINK PROGRAM('KVKT001') COMMAREA(COM_DIGER)
                                      RESP(RESP_CODE) NOHANDLE ;
    EXEC CICS ENTER TRACEID(3) FROM(COM_MUST_NO);
    IF RESP_CODE ^= 0 THEN COM_KVIZ_HATA = 6;

    CALL INTRNT_COM_AREA_ATAMA;

    COM_KOLON_NO(11) = K_KOLON;  COM_SIRA_NO(11) = K_SIRA;
    COM_KOLON_NO(12) = K_KOLON;  COM_SIRA_NO(12) = K_SIRA;
    COM_KOLON_NO(13) = K_KOLON;  COM_SIRA_NO(13) = K_SIRA;
    COM_KOLON_NO(14) = K_KOLON;  COM_SIRA_NO(14) = K_SIRA;

 END LINK_KVKT001;

 LINK_ITHI001:PROC;
    CALL COM_DIGER_INITIALIZE;

    COM_PRG_AD = 'ITHI001';
    EXEC CICS LINK PROGRAM('ITHI001') COMMAREA(COM_DIGER)
                                      RESP(RESP_CODE) NOHANDLE ;
    IF RESP_CODE ^= 0 THEN COM_KVIZ_HATA = 7;

    CALL INTRNT_COM_AREA_ATAMA;

    COM_KOLON_NO(15) = I_KOLON;  COM_SIRA_NO(15) = I_SIRA;
    COM_KOLON_NO(16) = I_KOLON;  COM_SIRA_NO(16) = I_SIRA;

 END LINK_ITHI001;

 LINK_ITHI002:PROC;
    CALL COM_DIGER_INITIALIZE;

    COM_PRG_AD = 'ITHI002';
    EXEC CICS LINK PROGRAM('ITHI002') COMMAREA(COM_DIGER)
                                      RESP(RESP_CODE) NOHANDLE ;
    IF RESP_CODE ^= 0 THEN COM_KVIZ_HATA = 8;

    CALL INTRNT_COM_AREA_ATAMA;

    COM_KOLON_NO(33) = O_KOLON;  COM_SIRA_NO(33) = O_SIRA;
    COM_KOLON_NO(34) = O_KOLON;  COM_SIRA_NO(34) = O_SIRA;

 END LINK_ITHI002;

 LINK_CEKC100:PROC;
    CALL COM_DIGER_INITIALIZE;

    COM_PRG_AD = 'CEKC100';
    EXEC CICS LINK PROGRAM('CEKC100') COMMAREA(COM_DIGER)
                                      RESP(RESP_CODE) NOHANDLE ;
    IF RESP_CODE ^= 0 THEN COM_KVIZ_HATA = 9;

    CALL INTRNT_COM_AREA_ATAMA;

    COM_KOLON_NO(17) = D_KOLON;  COM_SIRA_NO(17) = D_SIRA;
    COM_KOLON_NO(18) = D_KOLON;  COM_SIRA_NO(18) = D_SIRA;

 END LINK_CEKC100;

 LINK_SNET001:PROC;
    CALL COM_DIGER_INITIALIZE;

    COM_PRG_AD = 'SNET001';
    EXEC CICS LINK PROGRAM('SNET001') COMMAREA(COM_DIGER)
                                      RESP(RESP_CODE) NOHANDLE ;
    IF RESP_CODE ^= 0 THEN COM_KVIZ_HATA = 10;

    CALL INTRNT_COM_AREA_ATAMA;

    COM_KOLON_NO(19) = D_KOLON;  COM_SIRA_NO(19) = D_SIRA;
    COM_KOLON_NO(20) = D_KOLON;  COM_SIRA_NO(20) = D_SIRA;

 END LINK_SNET001;

 LINK_KVKK001:PROC;
    CALL COM_DIGER_INITIALIZE;

    COM_PRG_AD = 'KVKK001';
    EXEC CICS LINK PROGRAM('KVKK001') COMMAREA(COM_DIGER)
                                      RESP(RESP_CODE) NOHANDLE ;
    IF RESP_CODE ^= 0 THEN COM_KVIZ_HATA = 11;

    CALL INTRNT_COM_AREA_ATAMA;

    COM_KOLON_NO(26) = O_KOLON;  COM_SIRA_NO(26) = O_SIRA;
    COM_KOLON_NO(55) = O_KOLON;  COM_SIRA_NO(55) = O_SIRA;  /* YP */

 END LINK_KVKK001;

 LINK_KVTM001:PROC;
    CALL COM_DIGER_INITIALIZE;

    COM_PRG_AD = 'KVTM001';
    EXEC CICS LINK PROGRAM('KVTM001') COMMAREA(COM_DIGER)
                                      RESP(RESP_CODE) NOHANDLE ;
    IF RESP_CODE ^= 0 THEN COM_KVIZ_HATA = 12;

    CALL INTRNT_COM_AREA_ATAMA;

    COM_KOLON_NO(27) = O_KOLON;  COM_SIRA_NO(27) = O_SIRA;

 END LINK_KVTM001;

 LINK_CEKC101:PROC;
    CALL COM_DIGER_INITIALIZE;

    COM_PRG_AD = 'CEKC101';
    EXEC CICS LINK PROGRAM('CEKC101') COMMAREA(COM_DIGER)
                                      RESP(RESP_CODE) NOHANDLE ;
    IF RESP_CODE ^= 0 THEN COM_KVIZ_HATA = 13;

    CALL INTRNT_COM_AREA_ATAMA;

    COM_KOLON_NO(28) = O_KOLON;  COM_SIRA_NO(28) = O_SIRA;
    COM_KOLON_NO(29) = O_KOLON;  COM_SIRA_NO(29) = O_SIRA;

 END LINK_CEKC101;

 LINK_CEKC104:PROC;
    CALL COM_DIGER_INITIALIZE;

    COM_PRG_AD = 'CEKC104';
    EXEC CICS LINK PROGRAM('CEKC104') COMMAREA(COM_DIGER)
                                      RESP(RESP_CODE) NOHANDLE ;
    IF RESP_CODE ^= 0 THEN COM_KVIZ_HATA = 14;

    CALL INTRNT_COM_AREA_ATAMA;

    COM_KOLON_NO(35) = T_KOLON;  COM_SIRA_NO(35) = T_SIRA;
    COM_KOLON_NO(36) = T_KOLON;  COM_SIRA_NO(36) = T_SIRA;

 END LINK_CEKC104;

 LINK_SNET002:PROC;
    CALL COM_DIGER_INITIALIZE;

    COM_PRG_AD = 'SNET002';
    EXEC CICS LINK PROGRAM('SNET002') COMMAREA(COM_DIGER)
                                      RESP(RESP_CODE) NOHANDLE ;
    IF RESP_CODE ^= 0 THEN COM_KVIZ_HATA = 15;

    CALL INTRNT_COM_AREA_ATAMA;

    COM_KOLON_NO(37) = T_KOLON;  COM_SIRA_NO(37) = T_SIRA;
    COM_KOLON_NO(44) = T_KOLON;  COM_SIRA_NO(44) = T_SIRA;

 END LINK_SNET002;

 LINK_MKL540:PROC;
    CALL COM_DIGER_INITIALIZE;

    COM_PRG_AD = 'MKL540 ';
    EXEC CICS LINK PROGRAM('MKL540') COMMAREA(COM_DIGER)
                                      RESP(RESP_CODE) NOHANDLE ;
    IF RESP_CODE ^= 0 THEN COM_KVIZ_HATA = 16;

    CALL INTRNT_COM_AREA_ATAMA;

    COM_KOLON_NO(41) = M_KOLON;  COM_SIRA_NO(41) = M_SIRA;
    COM_KOLON_NO(42) = M_KOLON;  COM_SIRA_NO(42) = M_SIRA;

 END LINK_MKL540;

 LINK_BKHI001:PROC;
    CALL COM_DIGER_INITIALIZE;

    COM_PRG_AD = 'BKHI001';
    EXEC CICS LINK PROGRAM('BKHI001') COMMAREA(COM_DIGER)
                                      RESP(RESP_CODE) NOHANDLE ;
    IF RESP_CODE ^= 0 THEN COM_KVIZ_HATA = 17;

    CALL INTRNT_COM_AREA_ATAMA;

    COM_KOLON_NO(43) = O_KOLON;  COM_SIRA_NO(43) = O_SIRA;
    COM_KOLON_NO(45) = O_KOLON;  COM_SIRA_NO(45) = O_SIRA;

 END LINK_BKHI001;

 LINK_KMSL001:PROC;
    CALL COM_DIGER_INITIALIZE;

    COM_PRG_AD = 'KMSL001';
    EXEC CICS LINK PROGRAM('KMSL001') COMMAREA(COM_DIGER)
                                      RESP(RESP_CODE) NOHANDLE ;
    IF RESP_CODE ^= 0 THEN COM_KVIZ_HATA = 18;

    CALL INTRNT_COM_AREA_ATAMA;

    COM_KOLON_NO(23) = O_KOLON;  COM_SIRA_NO(23) = O_SIRA;
    COM_KOLON_NO(24) = O_KOLON;  COM_SIRA_NO(24) = O_SIRA;

 END LINK_KMSL001;

 LINK_BORC002:PROC;
    CALL COM_DIGER_INITIALIZE;

    COM_PRG_AD = 'BORC002';
    EXEC CICS LINK PROGRAM('BORC002') COMMAREA(COM_DIGER)
                                      RESP(RESP_CODE) NOHANDLE ;
    IF RESP_CODE ^= 0 THEN COM_KVIZ_HATA = 19;

    CALL INTRNT_COM_AREA_ATAMA;

    COM_KOLON_NO(32) = O_KOLON;  COM_SIRA_NO(32) = O_SIRA;

 END LINK_BORC002;

 LINK_EF2P008:PROC;
    CALL COM_DIGER_INITIALIZE;

    COM_PRG_AD = 'EF2P008';
    EXEC CICS LINK PROGRAM('EF2P008') COMMAREA(COM_DIGER)
                                      RESP(RESP_CODE) NOHANDLE ;
    IF RESP_CODE ^= 0 THEN COM_KVIZ_HATA = 20;

    CALL INTRNT_COM_AREA_ATAMA;

    COM_KOLON_NO(22) = O_KOLON;  COM_SIRA_NO(22) = O_SIRA;

 END LINK_EF2P008;

 LINK_VDLC001:PROC;
    CALL COM_DIGER_INITIALIZE;

    COM_PRG_AD = 'VDLC001';
    EXEC CICS LINK PROGRAM('VDLC001') COMMAREA(COM_DIGER)
                                      RESP(RESP_CODE) NOHANDLE ;
    IF RESP_CODE ^= 0 THEN COM_KVIZ_HATA = 21;

    CALL INTRNT_COM_AREA_ATAMA;

    COM_KOLON_NO(39) = M_KOLON;  COM_SIRA_NO(39) = M_SIRA;
    COM_KOLON_NO(40) = M_KOLON;  COM_SIRA_NO(40) = M_SIRA;

 END LINK_VDLC001;

 TOPLAM_KRITERLERI_HESAPLA:PROC;
 /* ------------- "46  " HESAP BİLGİLERİ TL KARŞILIĞI -------------- */
 /* ------------- "47  " HESAP BİLGİLERİ YP KARŞILIĞI -------------- */
    II = 1;
    ESKI_GRUP_KOD = ' ';

    TL_TUTAR  = 0; TL_ADET        = 0;
    YP_TUTAR  = 0; YP_ADET        = 0;
    TL_BULDUM = 0; YP_BULDUM      = 0;
    TEMP_RC   = 0; TEMP_TABLO_ADI = '';

    TL_KARSILIK = 0;
    YP_KARSILIK = 0;

    DO WHILE (COM_KRITER_NO(II) > 0 & II < 11 );
                        /* 8.8.2005   F.B.  ZERODIVIDE İÇİN KONTROL */
       IF COM_RC(II) = 0 THEN DO;
          IF COM_DVZ_TIP(II) = 'YTL' ! COM_DVZ_TIP(II) = '   ' !
             COM_DVZ_TIP(II) = 'TRL' ! COM_DVZ_TIP(II) = ''    !
             COM_DVZ_TIP(II) = 'TL ' THEN
             DO;
                TL_BULDUM = 1;
     (NOFOFL):  TL_TUTAR = TL_TUTAR + COM_TUTAR(II);
                TL_ADET  = TL_ADET  + COM_ADET (II);
             END;
             ELSE DO;
                YP_BULDUM = 1;
                CALL PARITE_BUL_2;
     (NOFOFL):  YP_TUTAR = YP_TUTAR + PARITE_KARSILIK;
                YP_ADET  = YP_ADET  + COM_ADET(II);
             END;
       END;
       II = II + 1;
    END;

    IF TL_BULDUM = 1 THEN DO;
       ESKI_KRITER_NO = '46';
       CALL COM_ATAMA_ORTAK;
       /*COM_DVZ_TIP (NDX) = 'YTL';*/
       COM_DVZ_TIP (NDX) = 'TL ';
       COM_TUTAR   (NDX) = TL_TUTAR;
       COM_ADET    (NDX) = TL_ADET;
    END;
    IF YP_BULDUM = 1 THEN DO;
       ESKI_KRITER_NO = '47';
       CALL COM_ATAMA_ORTAK;
       COM_DVZ_TIP (NDX) = ISTENEN_DVZ_TIP;
       COM_TUTAR   (NDX) = YP_TUTAR;
       COM_ADET    (NDX) = YP_ADET;
    END;

 /* ------------- "48  " KREDİ BİLGİLERİ TL KARŞILIĞI -------------- */
 /* ------------- "49  " KREDİ BİLGİLERİ YP KARŞILIĞI -------------- */
   /* COM_DVZ_TIP (48) = 'YTL'; */
    COM_DVZ_TIP (48) = 'TL ';
    COM_DVZ_TIP (49) = ISTENEN_DVZ_TIP;

    COM_ADET    (48) = COM_ADET  (11) + COM_ADET  (13) +
                       COM_ADET  (53) + COM_ADET  (54);
    COM_ADET    (49) = COM_ADET  (12) + COM_ADET  (14);

    (NOFOFL):TL_TUTAR= COM_TUTAR (11) + COM_TUTAR (13) +
                       COM_TUTAR (53) + COM_TUTAR (54);
    (NOFOFL):YP_TUTAR= COM_TUTAR (12) + COM_TUTAR (14);

    COM_TUTAR   (48) = TL_TUTAR;
    COM_TUTAR   (49) = YP_TUTAR;

 /* ------------- "50  " DEPO  BİLGİLERİ TL KARŞILIĞI -------------- */
 /* ------------- "51  " DEPO  BİLGİLERİ YP KARŞILIĞI -------------- */
    /* COM_DVZ_TIP (50) = 'YTL';*/
    COM_DVZ_TIP (50) = 'TL ';
    COM_DVZ_TIP (51) = ISTENEN_DVZ_TIP;

    COM_ADET    (50) = COM_ADET  (17) + COM_ADET  (19) + COM_ADET  (21);
    COM_ADET    (51) = COM_ADET  (18) + COM_ADET  (20);

    (NOFOFL):TL_TUTAR= COM_TUTAR (17) + COM_TUTAR (19) + COM_TUTAR (21);
    (NOFOFL):YP_TUTAR= COM_TUTAR (18) + COM_TUTAR (20);

    COM_TUTAR   (50) = TL_TUTAR;
    COM_TUTAR   (51) = YP_TUTAR;
 END TOPLAM_KRITERLERI_HESAPLA;

 PIYASA_BILGILERI:PROC;
    CALL FON_FIYAT_AL;
    CALL REPO_ORAN_AL;

    WDVZ_KOD = 9010;
    CALL DOVIZ_KUR_AL;

    COM_USD_SATIS = WDVZ_SATIS;
    COM_USD_ALIS  = WDVZ_ALIS;

    IF WDVZ_SATIS = WDVZ_SATIS2 THEN COM_USD_ARTIS = '=';
    IF WDVZ_SATIS < WDVZ_SATIS2 THEN COM_USD_ARTIS = '-';
    IF WDVZ_SATIS > WDVZ_SATIS2 THEN COM_USD_ARTIS = '+';

    WDVZ_KOD = 9190;
    CALL DOVIZ_KUR_AL;

    COM_EUR_SATIS = WDVZ_SATIS;
    COM_EUR_ALIS  = WDVZ_ALIS;

    IF WDVZ_SATIS = WDVZ_SATIS2 THEN COM_EUR_ARTIS = '=';
    IF WDVZ_SATIS < WDVZ_SATIS2 THEN COM_EUR_ARTIS = '-';
    IF WDVZ_SATIS > WDVZ_SATIS2 THEN COM_EUR_ARTIS = '+';

    CALL SEL_DAILY_GOLD_RATE;
    CALL SEL_DAILY_SILVER_RATE;
    
 END PIYASA_BILGILERI;

 FON_FIYAT_AL:PROC;
    COM_F2_ALIS  = 0;
    COM_F2_SATIS = 0;
    COM_F3_ALIS  = 0;
    COM_F3_SATIS = 0;
    COM_F4_ALIS  = 0;
    COM_F4_SATIS = 0;
    COM_F5_ALIS  = 0;
    COM_F5_SATIS = 0;
    COM_F6_ALIS  = 0;
    COM_F6_SATIS = 0;
    COM_F7_ALIS  = 0;
    COM_F7_SATIS = 0;
    COM_F8_ALIS  = 0;
    COM_F8_SATIS = 0;
    COM_F9_ALIS  = 0;
    COM_F9_SATIS = 0;
    COM_H1_ALIS  = 0;
    COM_H1_SATIS = 0;
    COM_H2_ALIS  = 0;
    COM_H2_SATIS = 0;
    COM_H3_ALIS  = 0;
    COM_H3_SATIS = 0;
    COM_H4_ALIS  = 0;
    COM_H4_SATIS = 0;
    COM_H5_ALIS  = 0;
    COM_H5_SATIS = 0;
    COM_H6_ALIS  = 0;
    COM_H6_SATIS = 0;

    EXEC SQL DECLARE FON_CRSR CURSOR FOR
             SELECT YFN_MKTUR, YFN_ALIS_FIYAT, YFN_SATIS_FIYAT
               FROM MKGUN_FON
               WHERE YFN_TAR = CURRENT DATE AND
                     YFN_MKTUR IN ('F2', 'F3', 'F4',
                                   'F5', 'F6', 'F7', 'F8',
                                   'F9', 'H1', 'H2', 'H3',
                                   'H4', 'H5', 'H6')
               WITH UR;
    EXEC SQL OPEN FON_CRSR;
    IF SQLCODE ^= 0 THEN DO;
       COM_F2_ALIS  = -1;
       COM_F2_SATIS = -1;
       COM_F3_ALIS  = -1;
       COM_F3_SATIS = -1;
       COM_F4_ALIS  = -1;
       COM_F4_SATIS = -1;
       COM_F5_ALIS  = -1;
       COM_F5_SATIS = -1;
       COM_F6_ALIS  = -1;
       COM_F6_SATIS = -1;
       COM_F7_ALIS  = -1;
       COM_F7_SATIS = -1;
       COM_F8_ALIS  = -1;
       COM_F8_SATIS = -1;
       COM_F9_ALIS  = -1;
       COM_F9_SATIS = -1;
       COM_H1_ALIS  = -1;
       COM_H1_SATIS = -1;
       COM_H2_ALIS  = -1;
       COM_H2_SATIS = -1;
       COM_H3_ALIS  = -1;
       COM_H3_SATIS = -1;
       COM_H4_ALIS  = -1;
       COM_H4_SATIS = -1;
       COM_H5_ALIS  = -1;
       COM_H5_SATIS = -1;
       COM_H6_ALIS  = -1;
       COM_H6_SATIS = -1;
       RETURN;
    END;

    EXEC SQL FETCH FON_CRSR INTO
                   :WYFN_MKTUR, :WYFN_ALIS_FIYAT, :WYFN_SATIS_FIYAT;
    IF SQLCODE ^= 0 & SQLCODE ^= 100 THEN DO;
       COM_F2_ALIS  = -2;
       COM_F2_SATIS = -2;
       COM_F3_ALIS  = -2;
       COM_F3_SATIS = -2;
       COM_F4_ALIS  = -2;
       COM_F4_SATIS = -2;
       COM_F5_ALIS  = -2;
       COM_F5_SATIS = -2;
       COM_F6_ALIS  = -2;
       COM_F6_SATIS = -2;
       COM_F7_ALIS  = -2;
       COM_F7_SATIS = -2;
       COM_F8_ALIS  = -2;
       COM_F8_SATIS = -2;
       COM_F9_ALIS  = -2;
       COM_F9_SATIS = -2;
       COM_H1_ALIS  = -2;
       COM_H1_SATIS = -2;
       COM_H2_ALIS  = -2;
       COM_H2_SATIS = -2;
       COM_H3_ALIS  = -2;
       COM_H3_SATIS = -2;
       COM_H4_ALIS  = -2;
       COM_H4_SATIS = -2;
       COM_H5_ALIS  = -2;
       COM_H5_SATIS = -2;
       COM_H6_ALIS  = -2;
       COM_H6_SATIS = -2;
       EXEC SQL CLOSE FON_CRSR;
       RETURN;
    END;

    DO WHILE (SQLCODE = 0);
       SELECT  ( WYFN_MKTUR );
          WHEN ( 'F2' ) DO; COM_F2_ALIS  = WYFN_ALIS_FIYAT;
                            COM_F2_SATIS = WYFN_SATIS_FIYAT; END;
          WHEN ( 'F3' ) DO; COM_F3_ALIS  = WYFN_ALIS_FIYAT;
                            COM_F3_SATIS = WYFN_SATIS_FIYAT; END;
          WHEN ( 'F4' ) DO; COM_F4_ALIS  = WYFN_ALIS_FIYAT;
                            COM_F4_SATIS = WYFN_SATIS_FIYAT; END;
          WHEN ( 'F5' ) DO; COM_F5_ALIS  = WYFN_ALIS_FIYAT;
                            COM_F5_SATIS = WYFN_SATIS_FIYAT; END;
          WHEN ( 'F6' ) DO; COM_F6_ALIS  = WYFN_ALIS_FIYAT;
                            COM_F6_SATIS = WYFN_SATIS_FIYAT; END;
          WHEN ( 'F7' ) DO; COM_F7_ALIS  = WYFN_ALIS_FIYAT;
                            COM_F7_SATIS = WYFN_SATIS_FIYAT; END;
          WHEN ( 'F8' ) DO; COM_F8_ALIS  = WYFN_ALIS_FIYAT;
                            COM_F8_SATIS = WYFN_SATIS_FIYAT; END;
          WHEN ( 'F9' ) DO; COM_F9_ALIS  = WYFN_ALIS_FIYAT;
                            COM_F9_SATIS = WYFN_SATIS_FIYAT; END;
          WHEN ( 'H1' ) DO; COM_H1_ALIS  = WYFN_ALIS_FIYAT;
                            COM_H1_SATIS = WYFN_SATIS_FIYAT; END;
          WHEN ( 'H2' ) DO; COM_H2_ALIS  = WYFN_ALIS_FIYAT;
                            COM_H2_SATIS = WYFN_SATIS_FIYAT; END;
          WHEN ( 'H3' ) DO; COM_H3_ALIS  = WYFN_ALIS_FIYAT;
                            COM_H3_SATIS = WYFN_SATIS_FIYAT; END;
          WHEN ( 'H4' ) DO; COM_H4_ALIS  = WYFN_ALIS_FIYAT;
                            COM_H4_SATIS = WYFN_SATIS_FIYAT; END;
          WHEN ( 'H5' ) DO; COM_H5_ALIS  = WYFN_ALIS_FIYAT;
                            COM_H5_SATIS = WYFN_SATIS_FIYAT; END;
          WHEN ( 'H6' ) DO; COM_H6_ALIS  = WYFN_ALIS_FIYAT;
                            COM_H6_SATIS = WYFN_SATIS_FIYAT; END;
          OTHERWISE;
       END;

       EXEC SQL FETCH FON_CRSR INTO
                      :WYFN_MKTUR, :WYFN_ALIS_FIYAT, :WYFN_SATIS_FIYAT;
    END;

    EXEC SQL CLOSE FON_CRSR;
    IF SQLCODE ^= 0 THEN DO;
       COM_F2_ALIS  = -3;
       COM_F2_SATIS = -3;
       COM_F3_ALIS  = -3;
       COM_F3_SATIS = -3;
       COM_F4_ALIS  = -3;
       COM_F4_SATIS = -3;
       COM_F5_ALIS  = -3;
       COM_F5_SATIS = -3;
       COM_F6_ALIS  = -3;
       COM_F6_SATIS = -3;
       COM_F7_ALIS  = -3;
       COM_F7_SATIS = -3;
       COM_F8_ALIS  = -3;
       COM_F8_SATIS = -3;
       COM_F9_ALIS  = -3;
       COM_F9_SATIS = -3;
       COM_H1_ALIS  = -3;
       COM_H1_SATIS = -3;
       COM_H2_ALIS  = -3;
       COM_H2_SATIS = -3;
       COM_H3_ALIS  = -3;
       COM_H3_SATIS = -3;
       COM_H4_ALIS  = -3;
       COM_H4_SATIS = -3;
       COM_H5_ALIS  = -3;
       COM_H5_SATIS = -3;
       COM_H6_ALIS  = -3;
       COM_H6_SATIS = -3;
       RETURN;
    END;

 END FON_FIYAT_AL;

 REPO_ORAN_AL:PROC;
    COM_REPO_ORAN = 0;
    COM_REPO_GUN  = 0;

    EXEC SQL DECLARE ORAN_CRS CURSOR FOR
              SELECT RSO_ORAN1, RSO_GUN1, RSO_SUBE
                FROM MKGUN_RSORAN
               WHERE RSO_TAR   = CURRENT DATE       AND
                     RSO_GUN1  > 1                  AND
                     RSO_SUBE IN (  'XXX',  '496',
                                  '00XXX','00496')  AND
                     RSO_MKTUR = '  '
               ORDER BY RSO_GUN1 ASC,RSO_SUBE DESC
               WITH UR;

    EXEC SQL OPEN ORAN_CRS;
    IF SQLCODE ^= 0 THEN DO;
       COM_REPO_ORAN = -1;
       COM_REPO_GUN  = -1;
       RETURN;
    END;

    EXEC SQL FETCH ORAN_CRS INTO :WRSO_ORAN1, :WRSO_GUN1, :WRSO_SUBE;
    IF SQLCODE ^= 0 & SQLCODE ^= 100 THEN DO;
       COM_REPO_ORAN = -2;
       COM_REPO_GUN  = -2;
       EXEC SQL CLOSE ORAN_CRS;
       RETURN;
    END;

    COM_REPO_ORAN = WRSO_ORAN1;
    COM_REPO_GUN  = WRSO_GUN1;

    EXEC SQL CLOSE ORAN_CRS;
    IF SQLCODE ^= 0 THEN DO;
       COM_REPO_ORAN = -3;
       COM_REPO_GUN  = -3;
       RETURN;
    END;

 END REPO_ORAN_AL;

 AJANDA_BILGILERI:PROC;
    CALL COM_BVIZ_INITIALIZE;

    EXEC CICS LINK PROGRAM('BVIZ005') COMMAREA(COM_BVIZ)
                                      RESP(RESP_CODE) NOHANDLE ;
    IF RESP_CODE ^= 0 THEN COM_KVIZ_HATA = 22;

    COM_BV05_HATA      = COM_BVIZ_HATA;
    COM_BV05_HATA_ACIK = COM_BVIZ_HATA_ACIK;
    COM_AJAND_20       = COM_BVIZ_AJAND_20;
    INDX = 0;

    /* TALİN DEFAULT 3 GÜNLÜK BİLGİ GÖNDERİYOR. KİŞİSELLEŞTİRMEDEKİ
       VADE ARALIĞINA GÖRE KAYITLARI AYIKLAYACAĞIM. İŞ BAŞA DÜŞTÜ.
       HADİ BAKALIM FÜSUN. 4.3.2003
    */

    DO I = 1 TO 20;
       TEMP_BVIZ_VADE = SUBSTR(COM_BVIZ_VADE(I),7,4) !! '-' !!
                        SUBSTR(COM_BVIZ_VADE(I),4,2) !! '-' !!
                        SUBSTR(COM_BVIZ_VADE(I),1,2);
       IF COM_BVIZ_VADE(I) > (10)' '    &
          TEMP_BVIZ_VADE   >= WMIN_VADE &
          TEMP_BVIZ_VADE   <= WMAX_VADE THEN DO;
          INDX = INDX + 1;
          COM_DVZ      (INDX) = COM_BVIZ_DVZ      (I);
          COM_VADE     (INDX) = COM_BVIZ_VADE     (I);
          COM_SAAT     (INDX) = COM_BVIZ_SAAT     (I);
          COM_ACIKLAMA (INDX) = COM_BVIZ_ACIKLAMA (I);
          COM_TUTARJ   (INDX) = COM_BVIZ_TUTAR    (I);
          COM_SIRANO   (INDX) = COM_BVIZ_SIRANO   (I);
       END;
    END;

    IF INDX >= 20 THEN COM_DVZ(20) = 'E'; /* 20 DEN FAZLA KAYIT VAR */

    IF COM_VADE(1) = (10)' ' THEN COM_BV05_HATA = 02; /* KAYIT YOK */

 END AJANDA_BILGILERI;

 COM_BVIZ_INITIALIZE:PROC;
    COM_PRG_AD            = 'BVIZ005';

    COM_BVIZ_HATA         = 0;
    COM_BVIZ_HATA_ACIK    = '';
    COM_BVIZ_MUST_NO      = COM_MUST_NO;
    COM_BVIZ_AJAND_20     = '';

    COM_BVIZ_DVZ      (*) = '';
    COM_BVIZ_VADE     (*) = '';
    COM_BVIZ_SAAT     (*) = '';
    COM_BVIZ_ACIKLAMA (*) = '';
    COM_BVIZ_TUTAR    (*) = 0;
    COM_BVIZ_SIRANO   (*) = 0;
 END COM_BVIZ_INITIALIZE;

 DOVIZ_KUR_AL:PROC;
    EXEC SQL SELECT DVZ_SATIS, DVZ_ALIS
             INTO   :WDVZ_SATIS, :WDVZ_ALIS
             FROM   DAILY_CURR_RATE
             WHERE  DVZ_KOD     = :WDVZ_KOD AND
                    KUR_TIP_KOD = 'I'
             WITH UR;

    IF SQLCODE ^= 0 THEN DO;
       WDVZ_ALIS  = -1;
       WDVZ_SATIS = -1;
       RETURN;
    END;

    EXEC SQL DECLARE DVZ_CRS CURSOR FOR
              SELECT DVZ_SATIS, DVZ_ALIS
                FROM CURR_RATE
               WHERE KUR_TAR     = CURRENT DATE - 1 DAYS AND
                     KUR_TIP_KOD = 'I'                   AND
                     DVZ_KOD     = :WDVZ_KOD
               ORDER BY KUR_ZMN DESC
               WITH UR;

    EXEC SQL OPEN DVZ_CRS;
    IF SQLCODE ^= 0 THEN DO;
       WDVZ_ALIS2  = -1;
       WDVZ_SATIS2 = -1;
       RETURN;
    END;

    EXEC SQL FETCH DVZ_CRS INTO :WDVZ_SATIS2, :WDVZ_ALIS2;

    IF SQLCODE ^= 0 THEN DO;
       WDVZ_ALIS2  = -2;
       WDVZ_SATIS2 = -2;
       EXEC SQL CLOSE DVZ_CRS;
       RETURN;
    END;

    EXEC SQL CLOSE DVZ_CRS;
    IF SQLCODE ^= 0 THEN DO;
       WDVZ_ALIS2  = -3;
       WDVZ_SATIS2 = -3;
       EXEC SQL CLOSE DVZ_CRS;
       RETURN;
    END;

 END DOVIZ_KUR_AL;

 LINK_KSSL004:PROC;

    CALL INITIALIZE_KSSL;
    COM_KSSL_MUST_NO = WPERS_MUST_NO; /* SLAVE VEYA MASTER */

    EXEC CICS LINK PROGRAM('KSSL004') COMMAREA(COM_KSSL)
                                      RESP(RESP_CODE) NOHANDLE ;

    IF RESP_CODE ^= 0 THEN DO;
       COM_PIYASA_RC = 11;
       RETURN;
    END;

    JJ = 1;

    IF COM_KSSL_RC = 2 THEN DO;
       COM_PIYASA_RC = 12;
       COM_PIYA_HATA_ACK = 'KAYIT YOK';
       RETURN;
    END;

    IF COM_KSSL_RC = 1  ! COM_KSSL_RC = 4 THEN DO;
       COM_PIYASA_RC = 13;
       COM_PIYA_HATA_ACK = COM_KSSL_HATA;
    END;

    IF COM_KSSL_RC = 3 THEN DO;
       COM_PIYASA_RC = 14;
       COM_PIYA_HATA_ACK = COM_KSSL_HATA;
    END;

    COM_USD_ALIS    =   COM_KSSL_USD_ALIS;
    COM_USD_SATIS   =   COM_KSSL_USD_SATIS;
    COM_USD_ARTIS   =   COM_KSSL_USD_ARTIS;
    COM_EUR_ALIS    =   COM_KSSL_EUR_ALIS;
    COM_EUR_SATIS   =   COM_KSSL_EUR_SATIS;
    COM_EUR_ARTIS   =   COM_KSSL_EUR_ARTIS;
    COM_ALTTL_ALIS  =   COM_KSSL_ALTTL_ALIS;
    COM_ALTTL_SATIS =   COM_KSSL_ALTTL_SATIS;
    COM_ALTUSD_ALIS =   COM_KSSL_ALTUSD_ALIS;
    COM_ALTUSD_SATIS=   COM_KSSL_ALTUSD_SATIS;
    COM_ALTEUR_ALIS =   COM_KSSL_ALTEUR_ALIS;
    COM_ALTEUR_SATIS=   COM_KSSL_ALTEUR_SATIS;
    COM_GMSTL_ALIS  =   COM_KSSL_GMSTL_ALIS;
    COM_GMSTL_SATIS =   COM_KSSL_GMSTL_SATIS;
    COM_GMSUSD_ALIS =   COM_KSSL_GMSUSD_ALIS;
    COM_GMSUSD_SATIS=   COM_KSSL_GMSUSD_SATIS;
    COM_GMSEUR_ALIS =   COM_KSSL_GMSEUR_ALIS;
    COM_GMSEUR_SATIS=   COM_KSSL_GMSEUR_SATIS;
    COM_F2_ALIS     =   COM_KSSL_F2_ALIS;
    COM_F2_SATIS    =   COM_KSSL_F2_SATIS;
    COM_F3_ALIS     =   COM_KSSL_F3_ALIS;
    COM_F3_SATIS    =   COM_KSSL_F3_SATIS;
    COM_F4_ALIS     =   COM_KSSL_F4_ALIS;
    COM_F4_SATIS    =   COM_KSSL_F4_SATIS;
    COM_F5_ALIS     =   COM_KSSL_F5_ALIS;
    COM_F5_SATIS    =   COM_KSSL_F5_SATIS;
    COM_F6_ALIS     =   COM_KSSL_F6_ALIS;
    COM_F6_SATIS    =   COM_KSSL_F6_SATIS;
    COM_F7_ALIS     =   COM_KSSL_F7_ALIS;
    COM_F7_SATIS    =   COM_KSSL_F7_SATIS;
    COM_F8_ALIS     =   COM_KSSL_F8_ALIS;
    COM_F8_SATIS    =   COM_KSSL_F8_SATIS;
    COM_F9_ALIS     =   COM_KSSL_F9_ALIS;
    COM_F9_SATIS    =   COM_KSSL_F9_SATIS;
    COM_H1_ALIS     =   COM_KSSL_H1_ALIS;
    COM_H1_SATIS    =   COM_KSSL_H1_SATIS;
    COM_H2_ALIS     =   COM_KSSL_H2_ALIS;
    COM_H2_SATIS    =   COM_KSSL_H2_SATIS;
    COM_H3_ALIS     =   COM_KSSL_H3_ALIS;
    COM_H3_SATIS    =   COM_KSSL_H3_SATIS;
    COM_H4_ALIS     =   COM_KSSL_H4_ALIS;
    COM_H4_SATIS    =   COM_KSSL_H4_SATIS;
    COM_H5_ALIS     =   COM_KSSL_H5_ALIS;
    COM_H5_SATIS    =   COM_KSSL_H5_SATIS;
    COM_H6_ALIS     =   COM_KSSL_H6_ALIS;
    COM_H6_SATIS    =   COM_KSSL_H6_SATIS;
    COM_REPO_ORAN   =   COM_KSSL_REPO_ORAN;
    COM_REPO_GUN    =   COM_KSSL_REPO_GUN;
    COM_USD_EUR_PAR =   COM_KSSL_USD_EUR_PAR;

    DO WHILE (JJ < 21 & COM_KSSL_ICERIK_TIP(JJ) ^= ' ');

       COM_ICERIK_KOD(JJ)     = COM_KSSL_ICERIK_KOD(JJ);
       COM_ICERIK_TIP_KOD(JJ) = COM_KSSL_ICERIK_TIP(JJ);

       JJ = JJ + 1;

    END;

 END LINK_KSSL004;

 INITIALIZE_KSSL:PROC;
    COM_KSSL_RC            = 0;
    COM_KSSL_MUST_NO       = 0;
    COM_KSSL_HATA          = (15)' ';
    COM_KSSL_ICERIK_KOD(*) = (6)' ';
    COM_KSSL_ICERIK_TIP(*) = ' ';
    COM_KSSL_USD_ALIS      = 0;
    COM_KSSL_USD_SATIS     = 0;
    COM_KSSL_USD_ARTIS     = ' ';
    COM_KSSL_EUR_ALIS      = 0;
    COM_KSSL_EUR_SATIS     = 0;
    COM_KSSL_EUR_ARTIS     = ' ';
    COM_KSSL_USD_EUR_PAR   = 0;
    COM_KSSL_ALTTL_ALIS    = 0;
    COM_KSSL_ALTTL_SATIS   = 0;
    COM_KSSL_ALTUSD_ALIS   = 0;
    COM_KSSL_ALTUSD_SATIS  = 0;
    COM_KSSL_ALTEUR_ALIS   = 0;
    COM_KSSL_ALTEUR_SATIS  = 0;
    COM_KSSL_GMSTL_ALIS    = 0;
    COM_KSSL_GMSTL_SATIS   = 0;
    COM_KSSL_GMSUSD_ALIS   = 0;
    COM_KSSL_GMSUSD_SATIS  = 0;
    COM_KSSL_GMSEUR_ALIS   = 0;
    COM_KSSL_GMSEUR_SATIS  = 0;
    COM_KSSL_F2_ALIS       = 0;
    COM_KSSL_F2_SATIS      = 0;
    COM_KSSL_F3_ALIS       = 0;
    COM_KSSL_F3_SATIS      = 0;
    COM_KSSL_F4_ALIS       = 0;
    COM_KSSL_F4_SATIS      = 0;
    COM_KSSL_F5_ALIS       = 0;
    COM_KSSL_F5_SATIS      = 0;
    COM_KSSL_F6_ALIS       = 0;
    COM_KSSL_F6_SATIS      = 0;
    COM_KSSL_F7_ALIS       = 0;
    COM_KSSL_F7_SATIS      = 0;
    COM_KSSL_F8_ALIS       = 0;
    COM_KSSL_F8_SATIS      = 0;
    COM_KSSL_F9_ALIS       = 0;
    COM_KSSL_F9_SATIS      = 0;
    COM_KSSL_H1_ALIS       = 0;
    COM_KSSL_H1_SATIS      = 0;
    COM_KSSL_H2_ALIS       = 0;
    COM_KSSL_H2_SATIS      = 0;
    COM_KSSL_H3_ALIS       = 0;
    COM_KSSL_H3_SATIS      = 0;
    COM_KSSL_H4_ALIS       = 0;
    COM_KSSL_H4_SATIS      = 0;
    COM_KSSL_H5_ALIS       = 0;
    COM_KSSL_H5_SATIS      = 0;
    COM_KSSL_H6_ALIS       = 0;
    COM_KSSL_H6_SATIS      = 0;
    COM_KSSL_REPO_ORAN     = 0;
    COM_KSSL_REPO_GUN      = 0;

 END INITIALIZE_KSSL;

 SEL_DAILY_GOLD_RATE:PROC;
    COM_ALTTL_ALIS   = -1;
    COM_ALTTL_SATIS  = -1;
    COM_ALTUSD_ALIS  = -1;
    COM_ALTUSD_SATIS = -1;
    COM_ALTEUR_ALIS  = -1;
    COM_ALTEUR_SATIS = -1;
    WDVZ_SATIS       = -1;
    WDVZ_ALIS        = -1;

    EXEC SQL DECLARE CRS1 CURSOR FOR
             SELECT  ALIS_FIYAT, SATIS_FIYAT, DVZ_KOD
             FROM    DAILY_GOLD_RATE
             WHERE   BRM_KOD     = 496       AND
                     KUR_TIP_KOD = 'B'       AND
                     DVZ_KOD    IN (9000, 9010, 9190)
             WITH UR;

    EXEC SQL OPEN CRS1;
    IF SQLCODE ^= 0 THEN RETURN;

    EXEC SQL FETCH CRS1 INTO :WDVZ_ALIS, :WDVZ_SATIS, :WDVZ_KOD;
    IF SQLCODE ^= 0 THEN DO;
       EXEC SQL CLOSE CRS1;
       RETURN;
    END;

    DO WHILE (SQLCODE = 0);
       SELECT (WDVZ_KOD);
          WHEN(9000) DO;
             COM_ALTTL_ALIS   = WDVZ_ALIS;
             COM_ALTTL_SATIS  = WDVZ_SATIS;
          END;
          WHEN(9010) DO;
             COM_ALTUSD_ALIS  = WDVZ_ALIS;
             COM_ALTUSD_SATIS = WDVZ_SATIS;
          END;
          WHEN(9190) DO;
             COM_ALTEUR_ALIS  = WDVZ_ALIS;
             COM_ALTEUR_SATIS = WDVZ_SATIS;
          END;
          OTHERWISE;
       END;
       EXEC SQL FETCH CRS1 INTO :WDVZ_ALIS, :WDVZ_SATIS, :WDVZ_KOD;
    END;
    IF SQLCODE ^= 0 & SQLCODE ^= 100 THEN RETURN;

    EXEC SQL CLOSE CRS1;
    IF SQLCODE ^= 0 THEN RETURN;
 END SEL_DAILY_GOLD_RATE;
 
 
 SEL_DAILY_SILVER_RATE:PROC;
    COM_GMSTL_ALIS   = -1;
    COM_GMSTL_SATIS  = -1;
    COM_GMSUSD_ALIS  = -1;
    COM_GMSUSD_SATIS = -1;
    COM_GMSEUR_ALIS  = -1;
    COM_GMSEUR_SATIS = -1;
    WDVZ_SATIS       = -1;
    WDVZ_ALIS        = -1;

    EXEC SQL DECLARE CRS2 CURSOR FOR
             SELECT  ALIS_FIYAT, SATIS_FIYAT, DVZ_KOD
             FROM    DAILY_SILVER_RATE
             WHERE   BRM_KOD     = 496       AND
                     KUR_TIP_KOD = 'B'       AND
                     DVZ_KOD    IN (9000, 9010, 9190)
             WITH UR;

    EXEC SQL OPEN CRS2;
    IF SQLCODE ^= 0 THEN RETURN;

    EXEC SQL FETCH CRS2 INTO :WDVZ_ALIS, :WDVZ_SATIS, :WDVZ_KOD;
    IF SQLCODE ^= 0 THEN DO;
       EXEC SQL CLOSE CRS2;
       RETURN;
    END;

    DO WHILE (SQLCODE = 0);
       SELECT (WDVZ_KOD);
          WHEN(9000) DO;
             COM_GMSTL_ALIS   = WDVZ_ALIS;
             COM_GMSTL_SATIS  = WDVZ_SATIS;
          END;
          WHEN(9010) DO;
             COM_GMSUSD_ALIS  = WDVZ_ALIS;
             COM_GMSUSD_SATIS = WDVZ_SATIS;
          END;
          WHEN(9190) DO;
             COM_GMSEUR_ALIS  = WDVZ_ALIS;
             COM_GMSEUR_SATIS = WDVZ_SATIS;
          END;
          OTHERWISE;
       END;
       EXEC SQL FETCH CRS2 INTO :WDVZ_ALIS, :WDVZ_SATIS, :WDVZ_KOD;
    END;
    IF SQLCODE ^= 0 & SQLCODE ^= 100 THEN RETURN;

    EXEC SQL CLOSE CRS2;
    IF SQLCODE ^= 0 THEN RETURN;
 END SEL_DAILY_SILVER_RATE;
 
 
 SEL_INTRNT_CCR_PRVT_USER_RL:PROC;
 
 	EXEC SQL SELECT MUST_NO_OZL
 	           INTO :WMUST_NO_OZL
 	           FROM INTRNT_CCR_PRVT_USER_RL
 	          WHERE MUST_NO  = :WMUST_NO         AND
 	                KULL_KOD = :COM_OZL_KULL_KOD AND
 	                DRM_KOD  = 'A'
 	                WITH UR; 	

 	IF SQLCODE ^= 0 THEN DO;
          COM_KVIZ_HATA      = SQLCODE;
          COM_KVIZ_TABLO_ADI = 'I_CCR_PRVT_USER_RL';
          EXEC CICS RETURN;
    END;
 END SEL_INTRNT_CCR_PRVT_USER_RL;
  
 END KVIZ001;
