-- MySQL dump 10.13  Distrib 8.0.19, for Win64 (x86_64)
--
-- Host: 51.161.212.218    Database: drawbridge_test
-- ------------------------------------------------------
-- Server version	5.5.5-10.11.6-MariaDB-1:10.11.6+maria~ubu2204

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

--
-- Table structure for table `divisions`
--

DROP TABLE IF EXISTS `divisions`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `divisions` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `division_name` varchar(100) NOT NULL,
  `league_id` int(11) NOT NULL,
  `role_id` bigint(20) NOT NULL,
  `category_id` bigint(20) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=84 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `logs`
--

DROP TABLE IF EXISTS `logs`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `logs` (
  `id` int(11) NOT NULL AUTO_INCREMENT COMMENT 'internal unique id',
  `match_id` int(11) DEFAULT NULL COMMENT 'match id on citadel',
  `team_id` int(11) DEFAULT NULL COMMENT 'FK to teams.id - admins are 1 and casters are 2',
  `user_id` bigint(20) NOT NULL COMMENT 'discord uid',
  `user_name` varchar(32) DEFAULT NULL COMMENT 'actual username of discord user',
  `user_nick` varchar(32) DEFAULT NULL COMMENT 'user''s alias in-server',
  `user_avatar` varchar(255) DEFAULT NULL COMMENT 'link to avatar on discord',
  `message_id` bigint(20) DEFAULT NULL COMMENT 'message id on discord',
  `message_content` varchar(3000) DEFAULT NULL COMMENT 'Text Only content of the message. Includes markdown. Does not included attachments or images.',
  `message_additionals` varchar(255) DEFAULT NULL COMMENT 'I guess maybe filename of an attachment or attachments? To be decided how this will be used.',
  `log_type` varchar(6) NOT NULL COMMENT 'edit/create/delete',
  `log_timestamp` timestamp NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=51 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `matches`
--

DROP TABLE IF EXISTS `matches`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `matches` (
  `match_id` int(11) NOT NULL,
  `division` varchar(12) NOT NULL,
  `team_home` int(11) NOT NULL COMMENT 'fk to teams',
  `team_away` int(11) NOT NULL COMMENT 'fk to teams',
  `channel_id` bigint(20) NOT NULL COMMENT 'discord channel id',
  `archived` tinyint(1) DEFAULT NULL COMMENT 'dont process this one again (already archived or deleted)',
  `league_id` int(11) NOT NULL,
  PRIMARY KEY (`match_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;


--
-- Table structure for table `teams`
--

DROP TABLE IF EXISTS `teams`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `teams` (
  `team_id` int(11) NOT NULL,
  `league_id` int(11) NOT NULL,
  `role_id` bigint(20) NOT NULL COMMENT 'discord role id',
  `team_name` varchar(100) NOT NULL,
  `team_channel` bigint(20) NOT NULL,
  `division` int(11) NOT NULL,
  KEY `teams_divisions_FK` (`division`),
  CONSTRAINT `teams_divisions_FK` FOREIGN KEY (`division`) REFERENCES `divisions` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping routines for database 'drawbridge_test'
--
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on 2024-06-25  0:42:26
